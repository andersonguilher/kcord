//! Captures what one Windows process tree plays (or everything except it) with
//! the process loopback API (Windows 10 2004+), the way Discord shares the audio
//! of a shared app.
//!
//! Usage: kcord-app-audio --include <pid> | --exclude <pid>
//!
//! stdout: raw 32-bit float PCM, 48 kHz, stereo, interleaved.
//! stderr: one status line: "ready", "error <message>" or "ended" (the target
//! process closed). The helper exits when stdin closes, so it never outlives KCord.

#[cfg(not(windows))]
fn main() {
    eprintln!("error only available on Windows");
    std::process::exit(2);
}

#[cfg(windows)]
fn main() {
    let (pid, mode) = match parse_args() {
        Some(args) => args,
        None => {
            eprintln!("error usage: kcord-app-audio --include <pid> | --exclude <pid>");
            std::process::exit(2);
        }
    };

    // KCord closes our stdin when it stops the share or quits.
    std::thread::spawn(|| {
        use std::io::Read;
        let mut sink = [0u8; 64];
        let mut stdin = std::io::stdin();
        while matches!(stdin.read(&mut sink), Ok(n) if n > 0) {}
        std::process::exit(0);
    });

    if let Err(error) = capture::run(pid, mode) {
        eprintln!("error {error}");
        std::process::exit(1);
    }
}

#[cfg(windows)]
fn parse_args() -> Option<(u32, capture::Mode)> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() != 2 {
        return None;
    }
    let mode = match args[0].as_str() {
        "--include" => capture::Mode::Include,
        "--exclude" => capture::Mode::Exclude,
        _ => return None,
    };
    let pid = args[1].parse::<u32>().ok().filter(|pid| *pid > 0)?;
    Some((pid, mode))
}

#[cfg(windows)]
mod capture {
    use std::io::Write;
    use windows::core::{implement, Interface, Ref, Result, HRESULT, IUnknown};
    use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT};
    use windows::Win32::Media::Audio::*;
    use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
    use windows::Win32::System::Com::{CoInitializeEx, BLOB, COINIT_MULTITHREADED};
    use windows::Win32::System::Threading::{
        CreateEventW, OpenProcess, SetEvent, WaitForSingleObject, PROCESS_SYNCHRONIZE,
    };
    use windows::Win32::System::Variant::VT_BLOB;

    pub enum Mode {
        Include,
        Exclude,
    }

    const SAMPLE_RATE: u32 = 48_000;
    const CHANNELS: u16 = 2;
    const BYTES_PER_FRAME: usize = 4 * CHANNELS as usize;
    const WAVE_FORMAT_IEEE_FLOAT: u16 = 3;
    // 100 ns units: 200 ms of buffer absorbs scheduling hiccups.
    const BUFFER_DURATION: i64 = 2_000_000;

    #[implement(IActivateAudioInterfaceCompletionHandler)]
    struct Completion {
        done: HANDLE,
    }

    impl IActivateAudioInterfaceCompletionHandler_Impl for Completion_Impl {
        fn ActivateCompleted(&self, _operation: Ref<IActivateAudioInterfaceAsyncOperation>) -> Result<()> {
            unsafe { SetEvent(self.done) }
        }
    }

    struct OwnedHandle(HANDLE);
    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    fn activate(pid: u32, mode: &Mode) -> Result<IAudioClient> {
        unsafe {
            let params = AUDIOCLIENT_ACTIVATION_PARAMS {
                ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
                Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
                    ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                        TargetProcessId: pid,
                        ProcessLoopbackMode: match mode {
                            Mode::Include => PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
                            Mode::Exclude => PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
                        },
                    },
                },
            };
            // PROPVARIANT's Drop calls PropVariantClear, which would free the
            // blob pointer: it points at `params` on the stack, not COM memory.
            let mut variant = std::mem::ManuallyDrop::new(PROPVARIANT::default());
            {
                let inner = &mut *variant.Anonymous.Anonymous;
                inner.vt = VT_BLOB;
                inner.Anonymous.blob = BLOB {
                    cbSize: std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
                    pBlobData: &params as *const _ as *mut u8,
                };
            }

            let done = OwnedHandle(CreateEventW(None, false, false, None)?);
            let handler: IActivateAudioInterfaceCompletionHandler = Completion { done: done.0 }.into();
            let operation = ActivateAudioInterfaceAsync(
                VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
                &IAudioClient::IID,
                Some(&*variant as *const PROPVARIANT),
                &handler,
            )?;
            if WaitForSingleObject(done.0, 10_000) != WAIT_OBJECT_0 {
                return Err(windows::core::Error::new(HRESULT(0x8000_000Au32 as i32), "activation timed out"));
            }
            let mut activate_result = HRESULT(0);
            let mut activated: Option<IUnknown> = None;
            operation.GetActivateResult(&mut activate_result, &mut activated)?;
            activate_result.ok()?;
            activated
                .ok_or_else(|| windows::core::Error::new(HRESULT(0x8000_4003u32 as i32), "no audio client"))?
                .cast()
        }
    }

    pub fn run(pid: u32, mode: Mode) -> Result<()> {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;

            // Only watched in include mode: the shared app closed, nothing left to capture.
            let target = match mode {
                Mode::Include => OpenProcess(PROCESS_SYNCHRONIZE, false, pid).ok().map(OwnedHandle),
                Mode::Exclude => None,
            };

            let client = activate(pid, &mode)?;
            let format = WAVEFORMATEX {
                wFormatTag: WAVE_FORMAT_IEEE_FLOAT,
                nChannels: CHANNELS,
                nSamplesPerSec: SAMPLE_RATE,
                nAvgBytesPerSec: SAMPLE_RATE * BYTES_PER_FRAME as u32,
                nBlockAlign: BYTES_PER_FRAME as u16,
                wBitsPerSample: 32,
                cbSize: 0,
            };
            client.Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
                BUFFER_DURATION,
                0,
                &format,
                None,
            )?;
            let ready = OwnedHandle(CreateEventW(None, false, false, None)?);
            client.SetEventHandle(ready.0)?;
            let capture: IAudioCaptureClient = client.GetService()?;
            client.Start()?;
            eprintln!("ready");

            let stdout = std::io::stdout();
            let mut out = stdout.lock();
            let mut silence: Vec<u8> = Vec::new();
            loop {
                let waited = WaitForSingleObject(ready.0, 250);
                if waited != WAIT_OBJECT_0 && waited != WAIT_TIMEOUT {
                    return Err(windows::core::Error::from_thread());
                }
                if let Some(target) = &target {
                    if WaitForSingleObject(target.0, 0) == WAIT_OBJECT_0 {
                        eprintln!("ended");
                        return Ok(());
                    }
                }
                let mut wrote = false;
                while capture.GetNextPacketSize()? > 0 {
                    let mut data = std::ptr::null_mut();
                    let mut frames = 0u32;
                    let mut flags = 0u32;
                    capture.GetBuffer(&mut data, &mut frames, &mut flags, None, None)?;
                    let bytes = frames as usize * BYTES_PER_FRAME;
                    let written = if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 || data.is_null() {
                        if silence.len() < bytes {
                            silence.resize(bytes, 0);
                        }
                        out.write_all(&silence[..bytes])
                    } else {
                        out.write_all(std::slice::from_raw_parts(data, bytes))
                    };
                    capture.ReleaseBuffer(frames)?;
                    // KCord went away: stop quietly.
                    if written.is_err() {
                        return Ok(());
                    }
                    wrote = true;
                }
                if wrote && out.flush().is_err() {
                    return Ok(());
                }
            }
        }
    }
}
