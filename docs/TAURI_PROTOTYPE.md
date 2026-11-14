# Protótipo Tauri para Windows

> Decisão arquitetural: este protótipo não substitui o Electron. O seletor
> protegido do WebView2 não oferece a experiência de enumeração de janelas com
> miniaturas exigida para o KCord. O cliente oficial permanece em Electron,
> assim como o desktop do Discord.

O protótipo confirma que o KCord pode manter o frontend React e o servidor atuais,
trocando apenas o shell Electron por Tauri/WebView2. Ele é paralelo ao cliente
Electron estável: usa outro identificador e o nome **KCord Tauri Preview**, portanto
não substitui nem atualiza uma instalação existente.

## Resultado de tamanho

Build da versão 0.1.8 em Windows x64:

- executável Tauri: aproximadamente 11 MiB;
- instalador NSIS: aproximadamente 2,4 MiB;
- instalador Electron otimizado: aproximadamente 100,9 MiB;
- aplicativo Electron desempacotado: aproximadamente 314,0 MiB.

O ganho ocorre porque o Tauri usa o WebView2 já fornecido pelo Windows, em vez de
embutir uma cópia completa do Chromium. Em uma máquina sem o runtime, o instalador
baixa o bootstrapper oficial do WebView2.

## Capacidades implementadas

- janela nativa carregando somente `https://kafcord.kafly.com.br` (e localhost de
  desenvolvimento na capability);
- ponte injetada apenas nas origens permitidas;
- instância única, bandeja e fechamento para a bandeja;
- iniciar com o Windows;
- PTT global por `GetAsyncKeyState`;
- compartilhamento de tela pelo seletor protegido do Windows/WebView2;
- shim de compatibilidade para a versão web atualmente publicada, que ainda
  espera os métodos de enumeração de fontes do Electron.

O seletor do sistema não entrega as miniaturas antecipadas usadas pelo Electron.
Depois que o frontend atualizado for publicado, o KCord abre o seletor do Windows
diretamente. Até lá, a página publicada mostra um cartão intermediário
“Escolher no Windows”.

## Executar e empacotar

Pré-requisitos: Node.js, Rust estável e WebView2 Runtime.

```powershell
npm install
npm run tauri:dev
npm run tauri:build
npm run test:tauri-package
```

O instalador é criado em
`src-tauri/target/release/bundle/nsis/KCord Tauri Preview_<versão>_x64-setup.exe`.

## Pendências antes de substituir o Electron

- implementar e assinar atualizações automáticas Tauri;
- validar PTT fora de foco com uma chamada controlada;
- validar captura de tela e áudio entre duas máquinas, com consentimento explícito
  para iniciar a transmissão;
- testar instalação, atualização e desinstalação em Windows 10 e 11;
- assinar o executável/instalador com Authenticode;
- confirmar que WebView2 suporta os dispositivos e codecs usados pelos usuários.

Até essas validações, o Electron continua sendo o cliente de produção e o Tauri é
uma prova técnica de migração.
