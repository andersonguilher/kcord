# KCord para Windows

O cliente desktop carrega `https://kafcord.kafly.com.br` em uma janela Electron
segura e adiciona apenas as capacidades nativas que o navegador não oferece.

## Compartilhamento de tela

- `desktopCapturer` enumera janelas e telas do Windows com miniaturas reais.
- A ponte `preload` usa isolamento de contexto e expõe somente operações
  específicas e validadas de compartilhamento.
- O usuário escolhe a fonte dentro do KCord antes de iniciar a transmissão.
- A lista de aplicativos junta a do Chromium (com miniaturas) e a do próprio
  Windows (`electron/window-list.cjs`, `EnumWindows` via `koffi`). O Chromium
  omite janelas que demoram a responder, e um jogo pesado como o X-Plane
  aparecia e sumia. As janelas que só o Windows lista aparecem "Sem prévia".
  Janelas minimizadas ficam fora, porque não podem ser capturadas. A captura
  usa direto o id escolhido no seletor, que precisa estar na última lista exibida.
- A captura usa o Windows Graphics Capture (flags `AllowWgc*` em `electron/main.cjs`).
  O capturador antigo deixava preto o vídeo acelerado por hardware, como o
  YouTube aberto em um navegador.
- No Windows 11 build 26100 ou posterior, o Chromium 151+ passou a forçar WGC
  para tela inteira e removeu a flag que escolhia DXGI. Se a faixa WGC não
  iniciar, o modo **Compatível** usa miniaturas JPEG do capturador independente
  do Electron e as transforma numa faixa de canvas de até 10 fps. Esse caminho
  prioriza funcionar, não fluidez; o auxiliar nativo ainda leva o áudio do
  computador. O modo pode ser trocado em Configurações → Windows.
- O áudio do computador é incluído por padrão usando loopback do Electron. Se o
  Windows recusar o loopback ("Could not start audio source"), a tela é
  compartilhada sem áudio e o usuário recebe um aviso.
- O áudio recebido da tela segue o dispositivo de saída e o volume escolhidos no KCord.
- No navegador comum, o KCord continua usando o seletor protegido do navegador.

## Push-to-talk global

No cliente Windows, a tecla configurada para PTT continua funcionando com a janela
sem foco ou recolhida na bandeja. O hook global fica ativo somente durante uma
chamada com o modo PTT habilitado e encaminha ao renderer apenas o estado da tecla
configurada.

O código da tecla é traduzido do `KeyboardEvent.code` do navegador, mas essa
tradução falha em alguns teclados e layouts (por exemplo, ABNT2). Por isso, sempre
que a tecla PTT é apertada com a janela em foco, o cliente pede ao hook o código
que ele acabou de ver e o salva em `kafcord:ptt-learned-key`. A partir daí, esse
código também aciona o PTT fora de foco. Se o hook não registrar nenhuma tecla, a
interface avisa que o PTT só funcionará com a janela em foco.

Desde a 0.1.8 existe um segundo detector, independente do hook
(`electron/ptt-poll.cjs`). A cada 15 ms ele lê o estado da tecla com
`GetAsyncKeyState`, chamado via `koffi`. O PTT fica ativo se qualquer um dos dois
detectores vir a tecla pressionada. Motivo: um usuário com Shift esquerdo só
transmitia com a janela em foco, mesmo depois do aprendizado de tecla.

Se a thread nativa do `uiohook-napi` desaparecer antes de ser encerrada, a
biblioteca lança `An unknown hook error occurred` e conserva internamente um
estado incorreto de execução. O KCord descarta essa instância pelo restante da
sessão e continua pelo detector `GetAsyncKeyState`; a falha de limpeza não gera
um incidente para o proprietário. Uma nova ativação ainda avisa o usuário caso
nenhum dos dois detectores esteja disponível.

O processo principal ainda responde a `ptt:diagnostics` (estado de cada detector
e quando a tecla foi vista pela última vez fora de foco), mas o painel que exibia
esses dados foi removido da interface depois que a correção foi confirmada. O
instalador inclui só o binário `win32_x64` do `koffi`.

## Iniciar com o Windows

A aba **Windows** das configurações aparece só no app instalado e liga ou desliga
a abertura automática no login, via `app.setLoginItemSettings`. A entrada fica em
`HKCU\Software\Microsoft\Windows\CurrentVersion\Run` com o nome `br.com.kafly.kcord`.
Em desenvolvimento a opção fica oculta, para não registrar o `electron.exe`.

## Executar e empacotar

```powershell
npm install
npm run desktop
npm run desktop:dist
npm run desktop:web-dist
```

O instalador é criado em `desktop-dist/KCord-Setup-<versão>.exe`.

Para distribuição normal, `desktop:web-dist` cria em `desktop-web-dist/nsis-web/` um
bootstrap pequeno (`KCord-Web-Setup-<versão>.exe`) e um pacote `.nsis.7z`. Os dois
artefatos e o `latest.yml` devem ser publicados juntos em `/downloads/`. O usuário
baixa apenas o bootstrap; ele detecta a arquitetura e baixa o pacote verificado
durante a instalação. O instalador offline continua disponível como contingência.
Na versão 0.1.8 de validação, o bootstrap ficou com 0,85 MiB e o pacote baixado
com 100,22 MiB.

O Electron usa a estrutura de dois manifestos recomendada pelo `electron-builder`:

- `package.json` contém as dependências do servidor, do frontend e do ambiente de
  desenvolvimento;
- `electron/package.json` contém somente as três dependências necessárias em
  execução no desktop: `electron-updater`, `koffi` e `uiohook-napi`;
- os comandos `desktop:pack` e `desktop:dist` atualizam automaticamente as
  dependências do diretório `electron/` antes de empacotar;
- o pacote Windows conserva somente os idiomas `pt-BR` e `en-US` e os binários
  nativos `win32_x64`.

O teste `npm run test:desktop-package` impede que dependências do frontend ou do
servidor voltem ao pacote, confere os idiomas, os binários nativos e a proteção da
fronteira IPC. Na versão 0.1.8, essa separação reduziu o aplicativo desempacotado
de 390,6 MiB para 314,0 MiB e o instalador de 114,5 MiB para 100,9 MiB.

Link público fixo para novos usuários: `https://kafcord.kafly.com.br/download`.
O servidor lê o campo `path` do `latest.yml` e redireciona (302, sem cache) para o
instalador correspondente; basta publicar o novo instalador e o `latest.yml` para o
link passar a entregar a versão nova. O site `kafly.com.br` usa esse link no botão
**Baixar KCord** da página inicial.

O aplicativo instalado consulta `https://kafcord.kafly.com.br/downloads/latest.yml`
ao iniciar e a cada minuto. Quando existe uma versão nova, baixa em segundo plano,
mostra o progresso na interface e avisa antes de reiniciar para concluir a instalação.
As atualizações são aplicadas silenciosamente no mesmo local e o KCord reabre ao
terminar; o assistente com escolha de pasta aparece somente na instalação inicial.
No relançamento com `--updated`, o cliente aguarda brevemente a instância anterior
liberar o bloqueio antes de abrir a nova versão.

O instalador ainda não possui assinatura Authenticode. O Windows SmartScreen pode
mostrar um aviso até que um certificado de assinatura de código seja configurado.
