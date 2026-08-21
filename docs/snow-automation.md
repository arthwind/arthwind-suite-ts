# Automação do Damage Report Entry (SNOW)

Módulo 24, `SnowAutomationModule.jsx` + `src/main/services/snowAutomation.ts`.

## O que faz

Lê a planilha já gerada pelo SNOW Processor (módulo 23, mesmo layout de
`OUTPUT_HEADERS` de `snowProcessor.ts`) e preenche automaticamente o
formulário "Create Damage Report Entry" na plataforma SNOW, linha por linha,
via navegador controlado (Playwright/Chromium).

## Sessão de login

Usa um perfil de navegador **persistente** (`launchPersistentContext`),
salvo em `%APPDATA%/ArthwindSuite/snow_browser_profile`. Login feito
manualmente uma vez (botão "Abrir p/ Login") continua valendo nas próximas
execuções — só precisa logar de novo quando a sessão expirar de verdade do
lado do ServiceNow, não a cada abertura do app.

## Widget dos campos — NÃO é `<select>` nativo

Confirmado via prints reais do formulário: os campos ("Blade serial number",
"Sub Component", "Failure Type", e a cascata Inside/Outside → Blade section
→ Blade sub-section → Blade area) são um combobox custom do ServiceNow:

1. Clica no campo pra abrir.
2. Aparece uma caixa de busca + lista de opções (com "-- None --" como
   primeiro item).
3. Digita pra filtrar (essencial em listas longas, tipo "Sub Component" com
   dezenas de itens "Accessoires - ...").
4. Clica na opção exata da lista.

`DamageEntryFiller.selectFromComboBox` (`snowAutomation.ts`) implementa esse
padrão via `getByLabel` (abrir o campo) + `getByRole('textbox').last()`
(caixa de busca, se aparecer) + `getByRole('option', { name, exact: true })`
(clicar na opção). **Ainda não testado contra o DOM real** — se
`getByRole('option', ...)` não achar nada, o widget provavelmente não expõe
role ARIA; troca por `page.locator('li', { hasText: optionText })` ou
`page.getByText(optionText, { exact: true })` como fallback. Rodar
`npx playwright codegen <url>` clicando manualmente nos campos é o jeito
mais rápido de confirmar/ajustar.

## Blade serial number — usar o serial completo

O combobox mostra o serial completo de 13 dígitos (ex.: `A1 811 0410 0115`),
não o Blade SN curto (`410`) usado internamente. `readDamageRows` já lê a
coluna A da planilha de saída do SNOW Processor, que já grava o
`fullBladeSerial` (via `getBladeInfo(bladeSn).serial`, `bladeSets.ts`) — não
precisa converter de novo aqui, só confirmar que a planilha usada tem esse
campo preenchido (depende do `blade_sets.json` ter a pá cadastrada).

## Cascata (Inside/Outside → Blade section → Blade sub-section → Blade area)

Cada campo só popula de verdade depois do anterior ser escolhido (visto nos
prints: aparecem como "-- None --"/"--None--" até o pai ser preenchido).
Parece ser filtragem client-side (rápida, sem round-trip de rede visível),
mas o código ainda espera o campo ficar visível/clicável antes de interagir
(sem `waitForTimeout` fixo).

## Fotos — nomenclatura sequencial obrigatória

O formulário avisa explicitamente: *"In case of a picture sequence, please
use numbers at attachment name begin (e.g.: 01_[Picture Name].jpg,
02_[Picture Name].jpg, etc.)"*. `uploadPhotos` já baixa e nomeia os arquivos
temporários como `01_...`, `02_...` etc. antes do upload — bate com a
exigência do cliente de múltiplas fotos por achado.

## Resiliência e Seletores com Fallback

- **Dropdowns Customizados (Combobox)**: `DamageEntryFiller.selectFromComboBox` agora conta com seletores em cascata de fallback:
  1. `getByRole('option', { name: optionText, exact: true })`
  2. `getByRole('option', { name: optionText })`
  3. `locator('li', { hasText: optionText })`
  4. `locator('div', { hasText: optionText })`
  5. `getByText(optionText, { exact: true })`
- **Navegação "Add Damage Entry"**: Localiza de forma resiliente usando seletores para botões, links ou elementos de texto (`/add damage entry|nova entrada|criar dano/i`).
- **Pós-Save**: Aguarda estado `networkidle` e confirmação antes de seguir para a próxima linha do lote.
- **Isolamento de Erros**: Cada linha do Excel roda em bloco isolado de `try/catch` — se um defeito falhar, o erro é registrado no log e o script segue para o próximo defeito sem parar o lote.
- **Faixa de Linhas**: É possível delimitar o intervalo de linhas a processar na UI (ex.: linhas 5 a 12) para retomar automações pausadas ou reprocessar falhas.

## Status da Implementação (v1.5.4)

- ✅ Módulo 24 (`SnowAutomationModule.jsx`) integrado na UI e registrado no `ModuleForm.jsx`.
- ✅ Backend em Playwright (`snowAutomation.ts`) com suporte a navegador persistente (`%APPDATA%/ArthwindSuite/snow_browser_profile`).
- ✅ Handlers IPC registrados em `src/main/index.ts` e expostos via `src/preload/index.ts`.
- ✅ Typecheck `node` e `web` passando com 0 erros.

## Bug corrigido: auditoria ao vivo não filtrava nada

`auditLiveDamageEntries` sempre rodou e logou corretamente ("X assinaturas
já cadastradas" ou "nenhum defeito detectado"), mas o `Set` retornado nunca
era capturado no call site (`await auditLiveDamageEntries(auditPage, log)`,
sem atribuição) — ou seja, a leitura acontecia, mas o resultado nunca era
usado pra pular linha nenhuma antes do processamento começar. Por isso
sempre parecia "não achar nada cadastrado" e seguia da linha 1, mesmo
quando a auditoria de fato encontrou entradas.

**Corrigido** em `runSnowDamageAutomation`: o `auditSet` agora é capturado e
usado via `rowAlreadyInLiveTable` pra filtrar `rows` **antes** do loop
principal, com log de quantas linhas foram puladas por já estarem na
tabela ao vivo. Esse filtro roda **além** do filtro por histórico local
(`submittedStore`) — os dois convivem, cobrindo tanto o que essa mesma
máquina já submeteu quanto o que já existe no ServiceNow por qualquer
outro meio (manual, outra máquina, etc.).

### Segundo bug (achado em teste real): falso-positivo por chave frouxa

Primeira versão do fix leu 11 linhas como "já submetidas" numa tabela que
só tinha 8 entradas reais — 3 falso-positivos. Causa: a chave solta
`shortSn+DF` (sem seção/área) casava com **qualquer número presente no
texto da linha da tabela** (sys_id, data, outra coluna), não só a coluna de
DF de verdade — bastava a pá bater e algum número aleatório coincidir.

**Corrigido**: `damageRowAuditKeys` e a construção do `auditSet` em
`auditLiveDamageEntries` agora só geram/aceitam a chave QUALIFICADA
(shortSn+seção+área+DF) — a chave solta foi removida dos dois lados.
Trade-off aceito de propósito: uma linha da planilha cuja área não apareça
no texto da linha da tabela simplesmente não é confirmável e não é pulada
(fica sujeita a ser processada de novo) — prefere isso a arriscar pular um
defeito real por engano, já que pular por engano é silencioso (o defeito
nunca é submetido e ninguém percebe) enquanto processar de novo é visível
e recuperável (fica um registro duplicado, perceptível na conferência).

### Terceiro bug (achado em teste real): navegação especulativa quebrava a página

`auditLiveDamageEntries` tinha uma segunda tentativa de navegação: se não
achasse um link clicável "Damage Report Entries" pra clicar, **adivinhava**
uma URL de lista (`/bam?id=u_damage_report_entry_list&sysparm_query=u_damage_report=<sys_id>`)
e navegava direto pra ela. Essa URL não existe nessa instância do
ServiceNow — a navegação caía numa tela real de erro/acesso negado
("Sorry, you are not allowed to access this page"), e toda a automação
seguia operando a partir dessa página quebrada.

**Corrigido (parcial)**: removida a navegação especulativa por URL
adivinhada, com salvaguarda pra voltar à URL original se cair numa tela de
erro por qualquer outro motivo. **Correção da suposição do "não precisa
navegar pra lugar nenhum" no item abaixo** — essa parte estava errada.

### Quarto bug (achado com print real da tela): a tabela NÃO fica na mesma página

O fix anterior assumiu que "Damage Report Entries" ficava embutida na
própria página do Inspection Report. **Errado** — é um link dentro da
seção "Related Lists" (no fim do formulário, com um badge de contagem ao
lado, ex.: "Damage Report Entries [8]") que abre uma **tela de lista
separada**, com URL própria gerada pelo próprio ServiceNow ao navegar (não
uma URL adivinhada por nós). Essa tela de lista tem colunas com nome real
("Blade serial number", "DF distance - Start (m)", "Sub Component", etc.),
bem diferente da estrutura solta que o código tentava adivinhar antes.

**Corrigido**:
- `navigateToDamageEntriesList`: clica no link "Damage Report Entries" de
  verdade (`getByText(/damage report entries/i)`, sem âncora `^...$` —
  a versão anterior usava âncora estrita, que provavelmente não batia com
  o texto real do link, contendo o badge de contagem colado ou espaço
  extra). Rola a página até o fim primeiro caso o link não apareça de
  cara (a seção Related Lists é lazy/fica fora da viewport inicial).
- `scanDamageEntriesTableByColumn`: em vez de escanear o texto inteiro da
  linha atrás de qualquer número (a fonte do falso-positivo do bug
  anterior), lê o cabeçalho da tabela pra achar o ÍNDICE das colunas
  "Blade serial number" e "DF distance" e extrai o valor exato de cada uma
  por célula — muito mais preciso, e permite voltar a usar a chave simples
  `shortSn+DF` (sem precisar de seção/área) com segurança, já que o DF
  agora vem garantidamente da coluna certa.
- Depois de auditar, `auditLiveDamageEntries` **volta pra URL original**
  do incidente — o resto da automação (clicar em "Add Damage Entry") espera
  estar na página do relatório, não na tela de lista aberta pra auditoria.

`auditLiveDamageEntries` também passou a distinguir e logar 3 cenários
diferentes (antes só existiam 2 mensagens, ambíguas):
1. Tabela encontrada com entradas → segue com o filtro normalmente.
2. Tabela encontrada e genuinamente vazia → log neutro, sem alarme.
3. **Tabela NÃO encontrada** (não conseguiu navegar até a lista, ou as
   colunas têm nome diferente do esperado) → log de aviso explícito,
   deixando claro que o filtro ao vivo não pôde ser aplicado (só o
   histórico local vale nesse caso) — antes essa situação gerava a mesma
   mensagem do cenário 2, escondendo o problema real.

## Paginação: a lista pode ter mais de 20 defeitos

A tela "Damage Report Entries" pagina em blocos de ~20 linhas (indicador
"Rows X - Y of Z" + setas `<`/`>`). A primeira versão de
`scanDamageEntriesTableByColumn` só lia a página inicial — turbinas com mais
de 20 defeitos cadastrados perdiam silenciosamente as entradas das páginas
seguintes, e o filtro ao vivo achava menos linhas do que realmente existiam.

**Corrigido**: a leitura foi separada em três funções —
- `scanCurrentListPage`: lê só a página atual (mesma lógica por índice de
  coluna de antes), acumulando no `Set` compartilhado.
- `goToNextListPage`: tenta uma cascata de seletores comuns pra botão/link
  de "próxima página" (`aria-label="Next"`, ícone `›`/`>`, classes
  `.pagination-next`/`.icon-next`), verificando se está desabilitado antes
  de clicar (fim da paginação).
- `scanDamageEntriesTableByColumn`: loop de até 50 páginas chamando as duas
  acima em sequência, logando o progresso por página (`+N entrada(s), total
  acumulado M`).

## `skipSubmitted` deixou de ser uma opção configurável

Existia um checkbox na UI (Módulo 24) pra ligar/desligar o filtro de "pular
linhas já submetidas" (histórico local + auditoria ao vivo). Isso foi um
erro de design: não existe cenário legítimo pra reprocessar uma linha já
cadastrada de propósito — o único efeito de desligar seria criar duplicata
no ServiceNow. O toggle nunca deveria ter sido uma opção do usuário.

**Corrigido**: `skipSubmitted` foi removido de `RunAutomationOptions`, do
checkbox da UI e das duas condicionais em `runSnowDamageAutomation` — os
dois filtros (histórico local via `submittedStore` e auditoria ao vivo via
`auditSet`) agora rodam **sempre**, de forma incondicional. O espaço do
checkbox na UI virou um texto informativo explicando o comportamento.

## Bug corrigido: upload de vídeo passava pra próxima linha sem submeter

`uploadPhotos` esperava um tempo FIXO de 1.5s depois de anexar cada arquivo,
antes de seguir pro próximo campo/submit. Isso é suficiente pra uma foto
JPEG, mas o vídeo das linhas DF 45-50 é muito maior — o upload de verdade
ainda estava em andamento quando o robô (no modo Submissão Automática) já
clicava em Submit, resultando em entradas submetidas sem o vídeo anexado
(ou o clique de Submit interrompendo o upload).

**Corrigido**: arquivos de vídeo (`.mp4`/`.mov`/`.avi`/`.mkv`, detectado por
`isVideoFile`) agora passam por
`DamageEntryFiller.waitForAttachmentUploaded`, que fica checando a cada 1s
se o nome do arquivo já apareceu na lista de anexos do formulário (sinal de
upload concluído), com timeout de até 3 minutos e log periódico a cada 15s
pra não parecer travado. Fotos continuam com o `waitForTimeout(1500)` de
sempre (não é o gargalo, upload de foto é rápido).

**Tentativa descartada**: a primeira versão desse fix fazia o vídeo subir
numa aba dedicada em SEGUNDO PLANO (upload + submit assíncrono, sem
bloquear o loop principal, seguindo pra próxima linha na aba compartilhada
enquanto o vídeo anterior ainda subia). Funcionalmente resolvia o mesmo
problema, mas o próprio usuário preferiu abrir mão do ganho de velocidade
em favor de estabilidade — a automação roda muito overnight, sem ninguém
por perto pra notar se algo trava com múltiplas abas simultâneas brigando
pelo mesmo contexto/sessão do navegador. **Revertido para sequencial**: o
upload de vídeo agora bloqueia normalmente (como qualquer outro campo),
só que com a espera correta do item acima em vez do tempo fixo — mais
lento por vídeo, mas sem o risco extra de duas abas ativas ao mesmo tempo.

## Bug corrigido: precisava clicar em "Abrir p/ Login" antes de rodar

Pra rodar "tranquilo", era preciso primeiro clicar em "🔑 Abrir p/ Login"
(abre a janela, navega até o incidente) e só DEPOIS clicar em rodar a
automação — sem esse passo manual, a automação podia navegar direto numa
tela de login/SSO (sessão expirada, ou primeiro uso) e seguir tentando
auditar/preencher um formulário que não existe ali, falhando de forma
confusa mais na frente (ex.: "A tela 'Create Damage Entry' não carregou a
tempo"). Não é um problema grave rodando uma turbina só com alguém por
perto, mas quebra a fila overnight — não tem ninguém pra notar a tela de
login travada às 3h da manhã.

**Corrigido**: `ensureAuthenticatedPage` (chamada logo no início de
`runSnowDamageAutomation`, antes até da auditoria ao vivo) navega até o
incidente e checa se a página é uma tela de login (campo de senha visível,
URL com padrão de login/SSO, ou texto típico de autenticação via
`isLoginPage`):
- Se a sessão já está logada (caso normal — inclusive entre turbinas
  diferentes da fila, que reusam a mesma sessão persistente): segue direto,
  sem qualquer espera extra.
- Se cair numa tela de login E o modo headless estiver DESLIGADO: traz a
  janela do navegador pra frente, loga um aviso claro, e fica esperando
  (checando a cada 3s) por até 5 minutos que o login seja concluído
  manualmente — dá tempo de alguém notar e agir, sem travar a automação
  pra sempre. Se não logar a tempo, aborta só ESSA turbina com um erro
  claro (`Sessão do ServiceNow não autenticada`) — na fila, isso não impede
  as próximas turbinas de tentar (cada uma faz sua própria checagem).
- Se cair numa tela de login E o modo headless estiver LIGADO: não tem como
  pedir login interativo sem janela visível — loga o aviso e desiste
  rápido, orientando a rodar uma vez sem headless pra logar manualmente.

O botão "🔑 Abrir p/ Login" continua existindo (útil pra confirmar
visualmente que a sessão está ok antes de uma fila longa), mas deixou de
ser um passo obrigatório antes de rodar.

### Bug corrigido (achado em teste real): falso-positivo — achava que não estava logado com a sessão 100% válida

A primeira versão de `isLoginPage` bastava achar um campo `input[type=password]`
"visível" em qualquer frame da página pra considerar tela de login. Em teste
real, isso disparou com o Inspection Report **totalmente carregado e
autenticado** (usuário "Rodolfo Meleiro" aparecendo no canto, formulário
inteiro renderizado) — o robô ficou esperando 5 minutos por um login que já
tinha acontecido.

Causa: o ServiceNow mantém um widget de reautenticação escondido no DOM
(`opacity: 0`, fora da viewport) pronto pra aparecer só quando a sessão
*realmente* expira — mesmo em páginas já logadas. O `isVisible()` do
Playwright não checa `opacity`, só `display`/`visibility`/tamanho da
bounding box, então esse campo de senha fantasma passava no teste de
"visível" sem nunca aparecer de verdade na tela.

**Corrigido**: `isLoginPage` agora exige DOIS sinais concordantes — campo
de senha visível **E** algum indício também visível de "Sign in"/"Log
in"/"Entrar" (botão ou texto) — antes de considerar que é mesmo uma tela
de login. Um campo de senha escondido sozinho não aciona mais o aviso.

## Fila overnight (várias turbinas em sequência)

Pra deixar rodando a noite inteira sem precisar ficar trocando de
turbina manualmente: a UI (`SnowAutomationModule.jsx`) agora tem uma fila.

- **"➕ Adicionar à Fila"**: pega os valores atuais do formulário (planilha,
  pasta de fotos, URL do incidente, pás selecionadas, e todas as opções —
  headless/autoSubmit/includeBlankImages/processOnlyVideos/faixa de linhas)
  e guarda como um item da fila (snapshot — mudar as opções depois não
  afeta itens já adicionados). Em seguida limpa o formulário
  (`resetTurbineForm`) pra configurar a próxima turbina.
- **"🌙 Rodar Fila Overnight (N)"**: dispara `handleRunQueue`, que roda os
  itens em SEQUÊNCIA — chama `snow_automation_run` pra cada um e só começa
  o próximo depois que o anterior retornar. Isso é proposital, não uma
  limitação: são todos a mesma sessão/perfil de navegador persistente
  (`%APPDATA%/ArthwindSuite/snow_browser_profile`), então rodar duas ao
  mesmo tempo bateria de frente com o lock do próprio Chromium nesse
  diretório (ver seção de instâncias simultâneas, se existir na
  documentação geral do app).
- **Falha numa turbina não para a fila**: cada iteração tem seu próprio
  try/catch — se uma turbina falhar (erro de rede, sessão expirada, etc.),
  o erro fica registrado no log e no status do item (✗), e a fila segue
  pra próxima. Isso é o que faz sentido pra um run overnight sem ninguém
  pra intervir; parar a fila inteira por causa de uma turbina travaria
  todas as outras até alguém notar de manhã.
- Cada item mostra status (⏳ pendente / ▶ rodando / ✓ concluído com
  contagem ok/falha / ✗ falhou com o erro) e pode ser removido da fila
  enquanto não está rodando.
- O botão "▶ Rodar Agora" continua existindo pra rodar só a turbina atual
  do formulário sem passar pela fila (uso pontual/teste rápido).

## Desambiguação de vídeo por nome do anexo (mais precisa que contagem)

Depois de trocar o painel de detalhe por validação de contagem (seção
abaixo), o usuário mandou um print de uma entrada de vídeo real
confirmando a causa raiz do painel nunca funcionar: os campos de uma
entrada JÁ CADASTRADA (Blade section, Sub Component etc.) aparecem como
texto travado/não-interativo — sem a mesma marcação de label do
formulário de criação. Ele também notou que o **nome do anexo** (ex.:
"B0545_S2_PS_DF45_DF50.mp4", visível no topo do painel) continua sendo um
link de texto normal, e já tem a Section+Area codificadas no próprio
nome (padrão do Módulo 23).

**Implementado**: em vez de só contar quantos vídeos existem por pá,
`readRowAttachmentFilename` clica em cada linha do grupo ambíguo e lê o
nome do anexo, `parseVideoAttachmentQuadrant` extrai Section+Area do
nome via regex (`_S(\d+)_([A-Za-z]{2})_DF`), e a chave qualificada
correspondente é adicionada ao `auditSet` — desambiguação de verdade,
sabe exatamente qual dos 4 quadrantes já existe, não só a contagem.

Detalhe importante: a confirmação de que o painel já atualizou pra linha
certa (antes só usava a DF Start) agora usa o **Número da entrada** (ex.:
"DAM1117031", lido de uma nova coluna "Number" identificada na lista) —
a DF não serve mais pra isso nesse caso específico, porque é IGUAL pras 4
linhas do mesmo grupo de vídeo (diferente de quando distinguia entre
linhas de DF diferentes).

Se a leitura do anexo falhar pra alguma linha específica, ela não é
marcada como já cadastrada (mesma filosofia de sempre — prefere reabrir
uma aba já feita a pular um vídeo real que falta). Teto de 24 leituras de
anexo por página, como salvaguarda.

## Categorias independentes (Defeitos/Blanks/Vídeos) + rodadas de retentativa automática

Duas mudanças de arquitetura pedidas pelo usuário, relacionadas entre si:

**1. Categorias independentes.** O antigo checkbox único "Apenas Vídeos"
virou 3 checkboxes independentes — Defeitos, Blank Images, Vídeos — todos
marcados por padrão. `RunAutomationOptions.processOnlyVideos` foi
substituído por `includeDefects`/`includeBlanks`/`includeVideos`
(default `true` cada). O filtro por categoria acontece bem no início,
antes até da auditoria — e desmarcar "Vídeos" faz a auditoria nem tentar
ler nome de anexo (a parte mais lenta, clica em cada linha ambígua e
espera o painel de detalhe) via um novo parâmetro `skipVideoAudit`
passado por `auditLiveDamageEntries` → `scanDamageEntriesTableByColumn` →
`scanCurrentListPage`. Motivo do pedido: quando o usuário só tem dúvida
sobre uma categoria (ex.: "sei que vídeo e blank estão OK, só não tenho
certeza dos defeitos"), não faz sentido pagar o custo da auditoria de
vídeo pra nada.

**2. Rodadas de retentativa automática (até 3).** A fase 1+2
(Defeitos+Blanks) agora roda em rodadas: linhas que falharem (timeout,
dropdown travado do SNOW, etc.) na rodada 1 são automaticamente
retentadas na rodada 2, e assim por diante, até `MAX_ROUNDS = 3` ou até
uma rodada não conseguir reduzir nada (sinal de problema persistente,
não vale insistir mais). Só conta como falha DEFINITIVA (incrementa
`failed`, entra em `errors`) depois de esgotar as rodadas — evita contar
a mesma linha como "falha" várias vezes. Motivo do pedido: antes, se
algumas linhas falhassem na primeira passada, o usuário precisava rodar
a automação inteira de novo manualmente só pra pegar o que sobrou; agora
isso acontece sozinho, sem sair da fase 1+2 (vídeo continua rodando só
depois, mesmo com retentativas de defeito/blank rolando antes).

**Fila overnight + vídeo manual — esclarecimento**: cada turbina da fila
roda o ciclo completo (defeitos+blanks com retentativa → vídeos) e só
passa pra próxima quando `runSnowDamageAutomation` RETORNA — isso
acontece assim que os vídeos são preenchidos e as abas ficam abertas,
**sem esperar revisão manual**. Numa fila com várias turbinas rodando a
noite toda, as abas de vídeo de TODAS as turbinas se acumulam abertas ao
longo da noite — de manhã, a revisão é de todas de uma vez, não turbina
por turbina.

## Bug corrigido: chave de auditoria usando DF End colidia com outro defeito real

Achado numa reconciliação manual (VSR-07-02, PDF x planilha): um defeito
real (pá 0566, Shell, Delamination, DF 48.1-48.4) que estava genuinamente
FALTANDO no ServiceNow não aparecia como pendente na auditoria — o robô
achava que já tinha sido cadastrado.

Causa: `damageRowAuditKeys` gerava, além da chave com DF Start, uma
SEGUNDA chave alternativa usando a DF End da linha — ideia original era
deixar a comparação mais tolerante. Só que existe OUTRO defeito real,
diferente, já cadastrado no ServiceNow, na MESMA pá, mesmo Sub Component,
mesmo Failure Type "Delamination", começando EXATAMENTE em DF 48.4 (onde
o primeiro termina). A chave do defeito faltante baseada na sua DF End
(48.4) batia com a chave do outro defeito real baseada na DF Start dele
(também 48.4) — falso-positivo. DF ranges que terminam onde outro começa
são um padrão comum em dano real (blade sendo documentada em segmentos
contínuos), não uma coincidência rara — então essa "tolerância" criava
mais problema do que resolvia.

**Corrigido**: `damageRowAuditKeys` usa só DF Start em todos os níveis de
qualificação — é o único valor que a tabela ao vivo do ServiceNow
realmente mostra (coluna "DF distance - Start (m)"), então é o único
comparável de forma confiável. Chave baseada em DF End removida por
completo.

## Bug corrigido: Blank Image subia a mesma foto duas vezes

`uploadPhotos` tratava Blank Image como qualquer defeito normal — pic1 +
pic2, duas fotos. Usuário apontou que não faz sentido: Blank Image é só
1 imagem, não um par.

**Corrigido**: agora sobe só 1 cópia da imagem Blank Image por linha.

## Bug corrigido: coluna "SNOW Entry #" gravava o IR do aerogerador em vez do DAM do defeito

Usuário reparou: a coluna "SNOW Entry #" estava sendo preenchida com o
mesmo valor (o IR do Inspection Report, ex.: "IR0066548") repetido em
várias linhas — errado, esse valor é do AEROGERADOR inteiro, não de um
defeito individual. O DAM de cada defeito (ex.: "DAM1117026") só é
gerado depois de submeter, e só aparece de verdade na tela "Damage
Report Entries".

Causa: `readSubmittedEntryNumber` usava `getByLabel('Number', {exact:
true}).first()` — mas o formulário tem MAIS de um campo/referência que
pode responder a um rótulo "Number" (o "Inspection Report" também é uma
referência tipo "IR0066548"). `.first()` nem sempre pegava o campo
certo.

**Corrigido**: em vez de confiar no primeiro candidato, varre TODOS os
elementos que batem com o rótulo "Number" e só aceita um valor que tenha
o formato de verdade de uma entrada de dano (regex `^DAM\d+$`) —
rejeita qualquer outro formato (IR..., INC..., TASK...) mesmo que
compartilhe o rótulo.

**Atenção**: linhas já gravadas ERRADAS na planilha (com o IR em vez do
DAM) continuam funcionando pro propósito de "não reprocessar" (a coluna
só precisa estar não-vazia pra isso), mas ficam com um valor cosmético
incorreto — se quiser o histórico visualmente correto, vale limpar essas
células manualmente ou verificar contra a tabela ao vivo do ServiceNow.

## Aba travada por bug do SNOW (dropdown "--None--") descartada automaticamente

Bug reportado pelo usuário, do LADO DO SERVICENOW (não da automação): quando
duas pessoas cadastram defeitos ao mesmo tempo, os dropdowns do formulário
às vezes travam mostrando só "--None--" pra sempre naquela aba específica
— um comportamento conhecido da plataforma, não algo que "destrava"
tentando de novo na mesma aba (por isso a retentativa que já existe em
`selectFromComboBox` não resolve: o problema não é o seletor, é a aba em
si). Em modo manual isso incomoda pouco (o usuário vê e recarrega). Em
modo Submissão Automática, como a aba é REAPROVEITADA entre linhas, sem
nenhuma ação a próxima linha herdaria a mesma aba travada e falharia de
novo, indefinidamente, até alguém notar manualmente.

**Implementado (sugestão do usuário)**: quando uma linha falha (em modo
autoSubmit), a aba do formulário é FECHADA antes de seguir pra próxima
linha. Como o código já verifica `context.pages().find(p =>
!p.isClosed())` no início de cada linha pra decidir se reaproveita uma
aba existente ou abre uma nova, fechar a aba travada faz a checagem não
achar nada aberto — a próxima linha abre uma aba nova do zero,
"resetando" o problema sem precisar de nenhuma lógica especial de
detecção do bug em si (não importa a causa exata da falha, qualquer erro
em modo automático descarta a aba por segurança). A linha que falhou
continua contabilizada como falha no resultado final — só não trava as
próximas.

**Cuidado apontado pelo usuário**: se a aba travada for a ÚNICA aba
aberta no contexto (cenário comum — modo automático reaproveita só uma
aba mesmo), fechar ela DIRETO corria o risco de derrubar a janela do
navegador inteira antes da próxima linha ter chance de abrir uma nova
(depende de como Windows/Chromium tratam fechar a última aba de uma
janela). Corrigido invertendo a ordem: abre uma aba nova EM BRANCO
primeiro (`context.newPage()`), e só DEPOIS fecha a travada — nunca fica
com zero abas abertas em nenhum momento.

## Bug corrigido: vídeo com só 1 entrada (não ambíguo) marcava os 4 quadrantes como prontos

Teste real: pá 545 tinha 4 vídeos cadastrados e foi auditada certinho
(lendo os 4 anexos, um por um). Mas pás 542 e 544 nem apareceram no log
de auditoria de vídeo — o robô simplesmente não tentou ler nada pra elas,
e todos os 12 vídeos (incluindo os de 542/544, que tinham só 1-2 vídeos
cadastrados) acabaram marcados como "já cadastrados" sem nenhuma leitura
de anexo.

Causa: a leitura de anexo só rodava dentro do bloco de GRUPOS AMBÍGUOS
(`group.length > 1`, ou seja, 2+ linhas com a mesma pá+DF45 na página).
Se uma pá tinha só 1 vídeo cadastrado naquele momento, essa linha caía no
caminho "não é ambíguo, é único" — que simplesmente adicionava a chave
SEM qualificação de Section/Area ao `auditSet`. Como essa chave solta é
uma das opções de match que `damageRowAuditKeys` gera pro lado da
planilha, isso batia com TODOS OS 4 vídeos daquela pá na planilha — o
robô achava que os 4 quadrantes já existiam só porque 1 existia, e nem
chegava a tentar ler o anexo pra descobrir os outros 3 que faltavam.

**Corrigido**: todo grupo de vídeo (DF Start = 45) — tenha 1, 2, 3 ou 4+
linhas — sempre lê o anexo de cada linha pra pegar a chave qualificada
exata (Section+Area). Só marca no `auditSet` o quadrante que realmente
foi confirmado por leitura — nunca mais usa a chave solta pra vídeo, nem
no caso "único". Isso é o que faz uma pá com só 1-2 vídeos cadastrados
continuar sendo auditada linha por linha em vez de ser ignorada de vez.

## Módulo 23: "Air Inclusion"/"Foreign Object" corrigidos pro plural real do SNOW

Achado investigando por que o robô nunca reconhecia um defeito "Air
Inclusion" já duplicado no ServiceNow: a chave da auditoria nunca batia
por causa de uma diferença de "s" — a planilha (gerada pelo Módulo 23)
grava "Air Inclusion" (singular), mas o dropdown REAL do SNOW usa "Air
inclusions" (plural). Padrão idêntico já tinha causado confusão antes com
"Foreign Object" (planilha, singular) x "Foreign objects" (SNOW, plural),
na investigação da VSR-06-01.

**Corrigido na fonte** (`SnowMappings.FAILURE_TYPES` em `snowProcessor.ts`
— o "de-para" do Módulo 23): `'Bubbles': 'Air Inclusion'` →
`'Bubbles': 'Air inclusions'`, e `'Foreign Object': 'Foreign Object'` →
`'Foreign Object': 'Foreign objects'`. Dados gerados pelo Módulo 23 DAQUI
PRA FRENTE já saem com o termo certo — inclusive faz a seleção do
combobox "Failure Type" no Módulo 24 bater por igualdade de verdade, em
vez de só um match por substring com sorte (já que "Air Inclusion" é
prefixo de "Air inclusions", o `hasText` antigo "funcionava" por
coincidência, mas a comparação exata da auditoria não).

A tolerância plural/singular na auditoria (próxima seção) continua
valendo — cobre dados JÁ CADASTRADOS antes dessa correção, com o termo
singular antigo.

## Auditoria: Failure Type comparado com tolerância plural/singular

Mesmo depois de corrigir a fonte no Módulo 23 (seção acima), dados JÁ
CADASTRADOS antes da correção continuam com o termo singular antigo
("Air Inclusion", "Foreign Object") gravado no ServiceNow — a auditoria
precisa reconhecer esses casos antigos também, não só os novos.

**Corrigido**: nova função `normalizeFailureType` (variante de
`normalizeSubComponent` que também remove um "s" final) usada
especificamente pra normalizar o Failure Type — nos dois lados
(`scanCurrentListPage`, lendo a tabela ao vivo, e `damageRowAuditKeys`,
lendo a planilha). "Air Inclusion" e "Air inclusions" caem no mesmo
`air inclusion` normalizado, batendo independente de qual lado tem o "s".
Aplicado só ao Failure Type — Sub Component/Section/Area continuam sem
essa tolerância (não há evidência do mesmo problema ali, e siglas curtas
como "SS"/"PS" arriscariam colisão indevida com um strip de "s" genérico).

## Bug corrigido (2ª tentativa): checagem de "painel atualizou" ainda não achava o valor certo

A correção anterior (usar `getByLabel('Number', {exact:true})` em vez de
`getByText` solto) resolveu o falso-positivo, mas criou um novo problema:
o campo "Number" nessa tela (uma entrada JÁ CADASTRADA) não tem a mesma
associação `<label for="...">` do formulário de criação — confirmado no
log de diagnóstico, que mostrou literalmente `campo Number mostra agora
"Number"` (o texto do RÓTULO, não o valor "DAM1117027"). `getByLabel`
não achava o campo de verdade, só o texto do rótulo, e a leitura nunca
batia com o número esperado — timeout sempre.

**Corrigido (3ª abordagem)**: em vez de procurar por rótulo/label, busca
o NÚMERO em si (`getByText(expectedDamNumber)`) em qualquer lugar da
tela, mas filtra fora qualquer ocorrência que esteja dentro de uma
`<table>` — a lista é uma tabela, o painel de detalhe não é. Isso separa
a ocorrência do número na LISTA (que causou o primeiro bug) da ocorrência
no PAINEL (que é o que realmente queremos), sem depender de nenhuma
marcação de acessibilidade/formulário — só da estrutura DOM (dentro ou
fora de tabela).

## Painel de detalhe abandonado — trocado por validação de contagem (HISTÓRICO — superado pela leitura de anexo acima)

O usuário achou um bug sério na versão anterior: um defeito NÃO-vídeo já
duplicado no ServiceNow (Air Inclusion, pá 0542, DF 49.5 — o mesmo
duplicado achado na reconciliação da VSR-06-03) continuava sendo
reprocessado pelo robô, mesmo já tendo 2 cópias lá. Print de uma entrada
de vídeo real (DAM1117026) confirmou que os campos "Blade section" /
"Blade sub-section" / "Blade area" existem no formulário com rótulos
normais — mas mesmo assim `readRowDetailPanel` continuava falhando 100%
das vezes em teste real, apesar do fallback de texto.

Causa do bug do duplicado: a lógica de agrupamento por assinatura
(pá+Sub Component+Failure Type+DF) tratava QUALQUER colisão do mesmo
jeito — tanto os 4 vídeos legítimos de uma pá quanto uma duplicata real —
tentando abrir o painel de detalhe pros dois casos. Como a leitura do
painel falha, e a correção anterior fazia "não confirmar nada" quando
falha (pra não arriscar pular vídeo real), isso também deixava
duplicatas REAIS sem proteção nenhuma.

**Corrigido — abandonado o painel de detalhe de vez, trocado por
validação de contagem** (sugestão do usuário: "os vídeos tinha que ao
menos ter a validação de que são 4 por blade"):

- **Grupo com DF Start = 45 (vídeo)**: conta quantas linhas existem no
  grupo. Se já são 4 ou mais (o total esperado de quadrantes por pá:
  Section 1/2 × PS/SS), marca como completo — não precisa saber QUAL
  quadrante é qual, só a contagem já garante que os 4 já existem. Se são
  menos de 4, não marca nada — os 4 vídeos correspondentes da planilha
  seguem pro processamento normal (pior caso: aba redundante pros que já
  existem, nunca duplica de verdade, já que vídeo é sempre revisão
  manual).
- **Qualquer outra colisão (não-vídeo)**: colisão de pá+componente+falha+DF
  fora do padrão de vídeo é, na prática, sempre uma duplicata real —
  confirma direto como já cadastrada, sem precisar abrir nada.

`readRowDetailPanel` e toda a lógica de clique+leitura do painel de
detalhe foram removidas do arquivo (código morto, sem mais nenhuma
chamada) — mais simples, mais rápido, e não depende de um seletor que
nunca funcionou de forma confiável em teste real.

## Desambiguação de grupo ambíguo: falha não cai mais na chave colapsada (HISTÓRICO — abandonada, ver correção acima)

Teste real (turbina com vídeos): mesmo com o fallback de texto no
`readRowDetailPanel` (seção acima), a leitura do painel continuou
falhando pra alguns grupos ambíguos ("Não deu pra ler o painel de
detalhe..."). O comportamento antigo, quando a leitura falhava, era cair
de volta na chave colapsada (`auditSet.add(baseKey)`) — mas isso tem um
efeito colateral perigoso: marca TODAS as linhas do grupo (ex.: os 4
vídeos DF45 de uma pá) como "já cadastradas" só porque UMA bateu com essa
assinatura fraca. Numa turbina real (VSR-06-03), isso quase causou vídeos
genuinamente faltando serem pulados por engano.

**Corrigido**: quando a desambiguação falha (seja por não conseguir ler o
painel, seja por exceder `MAX_DETAIL_LOOKUPS`), o grupo simplesmente NÃO
é adicionado ao `auditSet` — nem colapsado, nem qualificado. Consequência:
todas as linhas da planilha correspondentes a esse grupo seguem pro
processamento normal, sem serem filtradas como "já existentes". Pra
defeitos normais isso significa reprocessar (visível, recuperável). Pra
vídeo especificamente, o pior caso é abrir uma aba redundante pra revisar
— como o Submit de vídeo é sempre manual, nunca vira duplicata de
verdade. Mantém a mesma filosofia de sempre: prefere risco de duplicata
visível a risco de pular um defeito real silenciosamente.

## Zoom out removido — hipótese errada, causa raiz era outra

O bug "18 de 26 defeitos" (seção abaixo) foi originalmente atribuído a uma
grade virtualizada sem scroll funcional, e "corrigido" com um zoom out
programático (`document.body.style.zoom`) + rolagem repetida
(`growListUntilStable`). Só que, revisando depois, a causa raiz real era
outra: **colisão de chave** (linhas diferentes com a mesma pá+DF
colapsando numa assinatura só), já corrigida separadamente qualificando a
chave por Sub Component + Failure Type. A paginação real (numerada, com
setas "<"/">") sempre funcionou direito — não era necessário nenhum zoom
out pra ler as linhas.

**Removido**: `growListUntilStable` (função inteira) e as duas chamadas
de `document.body.style.zoom` em `scanDamageEntriesTableByColumn`. Menos
uma manipulação desnecessária da página durante a auditoria — o zoom out
não tinha efeito real no problema que motivou ele, só era uma variável a
mais que podia interferir em outra coisa (cliques, leitura de layout)
sem necessidade.

## Bug corrigido: lista sem barra de rolagem escondia parte dos defeitos da auditoria (hipótese HISTÓRICA — ver correção acima)

Reportado pelo usuário: a tela "Damage Report Entries" não mostra barra de
rolagem mesmo quando tem mais linhas do que cabe na tela — a única forma de
ver tudo manualmente é dar zoom out no navegador. Isso batia com o sintoma
observado na auditoria ao vivo: numa turbina com 26 defeitos cadastrados,
só 18 eram detectados.

Causa provável: a grade da lista é virtualizada (só monta no DOM as linhas
dentro da área "visível" da tela) e o contêiner de scroll está com algum
CSS quebrado (`overflow` errado, ou altura fixa menor que o conteúdo) — sem
scroll funcional, as linhas fora da área inicialmente renderizada nunca
chegam a existir no DOM, então `table tbody tr` simplesmente não as
enxerga. Não é paginação de verdade (por isso o `goToNextListPage` não
encontrava nada pra clicar e a leitura parava ali, silenciosamente).

**Corrigido**: `growListUntilStable` (chamada antes de cada leitura de
página em `scanDamageEntriesTableByColumn`) reproduz o mesmo efeito do
zoom out manual — reduz o `zoom` do `body` da página via
`document.body.style.zoom = '0.3'` antes de começar (mais conteúdo cabe na
área "visível", então a grade virtualizada monta mais linhas de cara) — e
complementa rolando repetidamente (`scrollIntoViewIfNeeded` na última
linha + `window.scrollTo` até o fim) até o número de linhas no DOM parar
de crescer, com log informando quantas linhas "apareceram" depois do
scroll. O zoom é restaurado (`= '1'`) num `finally` ao fim da leitura de
todas as páginas.

## Bug corrigido (achado em teste real): chave só por DF colapsava defeitos diferentes na mesma distância

Teste real numa turbina com 45 entradas cadastradas: a auditoria leu as 3
páginas corretamente (16 + 20 + 4), mas só chegou a 40 assinaturas únicas
— 5 "sumiram". Olhando a tabela ao vivo, dava pra ver o motivo: várias
linhas com a MESMA pá e a MESMA "DF distance - Start (m)", mas Sub
Component diferente (ex.: "Blade Inside - Shell" e "Blade Inside - Web
laminate" ambos na DF 40.5). Como a chave da auditoria era só `pá+DF`
(decisão tomada no "Quarto bug" acima, quando a leitura por coluna deixou
de precisar da qualificação por seção/área pra evitar falso-positivo),
essas linhas diferentes colapsavam numa única assinatura no `Set` — um
defeito novo caindo na mesma DF de um componente diferente já cadastrado
podia ser pulado por engano, achando que já tinha sido submetido.

**Corrigido**: `scanCurrentListPage` agora também localiza a coluna "Sub
Component" (existe nessa tela, junto com "Blade serial number" e "DF
distance") e, quando encontrada, qualifica a chave como
`pá_subComponentNormalizado_DF` em vez de só `pá_DF` — `normalizeSubComponent`
trata diferenças bobas de formatação (maiúsculas, espaços, traço de
prefixo). `damageRowAuditKeys` (lado da planilha) gera a mesma chave
qualificada a partir de `row.subComponent`, MAIS a chave antiga sem
qualificação como fallback — cobre o caso raro de a coluna Sub Component
não ser encontrada na tabela (aí o `Set` só tem chaves não-qualificadas, e
o fallback ainda bate). Não reintroduz o falso-positivo do "Segundo bug":
aquele vinha de escanear texto solto atrás de qualquer número; aqui a
coluna é lida por índice exato, então qualificar por ela não perde
precisão.

### Refinamento: Sub Component sozinho não bastava — faltava Failure Type

Analisando a planilha real que gerou aquela tabela (`VSR-06-01_Novo_Excel.xlsx`),
achei outro padrão de colisão que a qualificação por Sub Component (item
acima) não cobre: linha 9 e linha 43 da planilha são a MESMA pá (0548), o
MESMO Sub Component ("Blade Inside - Shell") e a MESMA "DF distance -
Start (m)" (40.0) — mas Failure Type diferente ("Deviation Core Material"
x "Delamination"). Como só Sub Component qualificava a chave, essas duas
linhas ainda colapsavam numa assinatura só.

**Corrigido**: `scanCurrentListPage` agora também localiza a coluna
"Failure type" (existe na tela, confirmada nos prints reais) e monta a
chave mais qualificada possível, em cascata — `pá_subComponent_failureType_DF`
se achou as duas colunas, `pá_subComponent_DF` se só achou uma, ou
`pá_DF` se não achou nenhuma. `damageRowAuditKeys` (lado da planilha) gera
as três variantes e testa todas via `.some()`, cobrindo qualquer nível de
qualificação que a tabela ao vivo conseguiu produzir.

### Resolvido: desambiguação das 4 fotos/vídeos de DF 45-50 por pá via painel de detalhe

As 4 entradas de vídeo por pá (Section 1/2 × PS/SS, todas DF 45-50) têm
**Sub Component E Failure Type idênticos** ("Blade Inside - Shell" /
"Type of Failure is Missing" pra todas as 4) — o único jeito de
diferenciá-las é por "Blade section"/"Blade sub-section"/"Blade area" (qual
quadrante da pá), que **não aparecem como coluna na tela de lista**
"Damage Report Entries" (só no formulário/painel de detalhe da entrada).

O usuário reparou que clicar numa linha da lista abre um painel de
detalhe à direita (é uma view mestre/detalhe — a lista continua visível à
esquerda) com TODOS os campos da entrada, incluindo Blade section/
sub-section/area. Baseado nisso:

**Implementado**: `scanCurrentListPage` agora agrupa as linhas por
assinatura (pá+Sub Component+Failure Type+DF) ANTES de gravar no
`auditSet`. Grupos com uma linha só vão direto pro `Set` (caminho rápido,
a maioria das linhas). Grupos com mais de uma linha (ambíguos — ex.: os 4
vídeos de uma pá) disparam `readRowDetailPanel`: clica na linha, espera o
painel abrir, e lê Blade section/sub-section/area — a chave gravada no
`Set` fica totalmente qualificada com esses 3 campos a mais.
`damageRowAuditKeys` (lado da planilha) gera a variante equivalente a
partir de `row.bladeSection`/`bladeSubSection`/`bladeArea`.

**Cuidado importante (avisado pelo usuário em teste real)**: o painel de
detalhe tem delay considerável pra abrir, e se já tinha um aberto de uma
linha anterior, o painel novo demora ~3s pra aparecer POR CIMA do antigo —
logo depois do clique, o painel ainda mostra dados da linha ANTERIOR por
um tempo. Só checar "o painel está visível" não bastava (sempre estaria,
é o painel velho). `readRowDetailPanel` recebe o valor de DF distance
esperado (já lido da coluna da lista) e só aceita a leitura quando o "DF
distance - Start (m)" MOSTRADO NO PAINEL bater com esse valor — confirma
que o painel já atualizou pra linha certa antes de ler Section/Sub-section/
Area, evitando ler dados velhos por engano. Timeout de até 15s por linha.

Teto de segurança: no máximo 12 desambiguações por página (cada uma é
lenta de propósito — só compensa pra grupos pequenos de verdade
ambíguos). Se um grupo ultrapassar o teto, fica com a chave colapsada
mesmo (mesmo trade-off de sempre: prefere risco de pular um defeito real
a travar a auditoria inteira tentando desambiguar demais).

## Blank Image auditada por CONTAGEM, não por linha

`extractBladeSn('Blank Image')` retorna vazio (não tem 4 dígitos pra
achar) — então essas linhas nunca entravam na leitura por pá+DF da tabela
ao vivo nem na montagem de chave da planilha. Mas o problema é mais fundo
que só isso: quando uma linha "Blank Image" É submetida de verdade,
`readDamageRows` já reatribui o `bladeSerialNumber` pro último blade REAL
válido da planilha (`lastValidBladeSerial`) — então na tabela do
ServiceNow essa entrada aparece com uma pá de verdade, indistinguível de
um defeito real daquela pá pelos campos visíveis. Auditar Blank Image por
pá+DF nunca faria sentido, mesmo se `extractBladeSn` funcionasse pra ela.

**Implementado**: em vez de tentar casar cada linha "Blank Image" da
planilha com uma linha específica do ServiceNow, `scanCurrentListPage`
CONTA quantas entradas já existem (reconhecidas pela "Damage Description"
= "Empty entry", texto fixo que o Módulo grava só pra essas linhas) —
independente de qual pá foi usada pra registrar. `runSnowDamageAutomation`
usa essa contagem pra calcular quantas ainda faltam
(`Math.max(0, 5 - blankImageCount)`) e mantém só essa quantidade das
linhas "Blank Image" da planilha, descartando o excedente — preserva a
exigência do cliente de exatamente 5 por turbina sem duplicar.

## Fallback de texto pra leitura do painel de detalhe (getByLabel falhou 100% em teste real)

Depois de implementar a desambiguação por painel de detalhe (seção
anterior), um teste real mostrou `readRowDetailPanel` falhando em TODAS as
tentativas (7 de 7, "Não deu pra ler o painel de detalhe") — mesmo pra
grupos de linhas com pás/DFs bem diferentes entre si, o que descarta
"são duplicatas genuínas" como única explicação (mesmo duplicatas de
verdade deveriam permitir a LEITURA, só resultariam numa chave igual).
Indício forte de que `getByLabel` simplesmente não encontra os campos
"Blade section"/"Blade sub-section"/"Blade area" NESSA tela — o painel de
detalhe provavelmente não usa a mesma associação `<label for="...">` que o
formulário de edição usa (talvez só texto estático, sem marcação de
acessibilidade formal).

**Corrigido (sem confirmação visual do DOM real — testar e ajustar se
ainda falhar)**: `readField` e a checagem de presença do painel agora têm
um fallback baseado em texto — se `getByLabel` não achar nada, localiza o
elemento que contém o TEXTO do rótulo (`getByText`), sobe pro container
mais próximo (`xpath=ancestor::*[self::div or self::td or self::li][1]`)
e lê o texto completo do container, removendo o próprio texto do rótulo
pra sobrar só o valor. Mais frágil que uma leitura por label de verdade,
mas não depende de marcação de acessibilidade específica.

## Blank Image deixou de ser opcional

`includeBlankImages` era um checkbox (padrão desligado) que decidia se as
linhas "Blank Image" da planilha entravam no processamento. Segundo o
usuário: isso está errado — toda inspeção, sem exceção, exige exatamente 5
Blank Image, não é um comportamento facultativo (mesmo caso do
`skipSubmitted`, que também deixou de ser toggle antes).

**Corrigido**: removida a condicional em `readDamageRows` — as linhas
"Blank Image" da planilha sempre entram no processamento agora. Removido
o campo `includeBlankImages` de `RunAutomationOptions`, o checkbox da UI,
e o state associado. A proteção contra duplicata continua sendo a
auditoria por contagem (seção acima) — não precisa mais de opção pra
"ativar" isso, sempre roda.

Nota à parte: linhas de vídeo (DF 45-50) já eram incluídas por padrão em
qualquer run normal — `processOnlyVideos` só FILTRA pra rodar só elas,
nunca as excluiu quando desligado. Então, ao contrário de Blank Image,
vídeo nunca teve esse problema de exclusão por padrão.

## Vídeos processados em cascata, sempre em modo manual (fase separada)

O robô esperava (bloqueando) o upload do vídeo terminar antes de seguir
pra próxima linha — mesmo depois de trocar o `waitForTimeout` fixo por uma
espera de verdade (ver bug corrigido acima), isso ainda desperdiçava muito
tempo: o upload de um vídeo demora bem mais que preencher 3-4 formulários
inteiros (que é praticamente instantâneo — é cópia/cola de dados). O
usuário apontou o problema e propôs a solução: preencher o formulário,
disparar o upload SEM esperar terminar, e já pular pra próxima aba — o
tempo de preencher os próximos formulários naturalmente "cobre" o tempo de
upload dos anteriores (cascata).

O ponto crítico da proposta (e o que evita reintroduzir o bug de "clicou
Submit antes do upload terminar" de uma tentativa anterior, já revertida):
vídeo **nunca é auto-submetido**, nem em modo Submissão Automática. Sem
precisar verificar "o upload terminou de verdade?" antes de decidir
submeter — simplesmente nunca submete sozinho, sempre deixa a aba aberta
pra revisão manual. Confiabilidade fica com o inspetor conferindo o
Damage Report Entries antes de enviar, não com um log interno do robô.

**Implementado**:
- `runSnowDamageAutomation` agora processa em 3 fases, nessa ordem fixa:
  1. Defeitos normais (sequencial, aba compartilhada, como sempre foi).
  2. Blank Images (mesmo loop da fase 1 — só reordenadas pra vir depois
     dos defeitos de verdade).
  3. Vídeos (DF 45-50) — loop separado, cada vídeo abre sua PRÓPRIA aba
     nova, preenche o formulário, dispara o upload e segue pro próximo
     SEM esperar. `openDamageEntryForm` (função extraída do loop
     principal — clicar "Add Damage Entry" + esperar o formulário ficar
     pronto, com todas as retentativas de sempre) é reusada pelas duas
     fases, evitando duplicar essa lógica.
- `DamageEntryFiller.fill()` e `uploadPhotos()` ganharam um parâmetro
  `waitForVideoUpload` (padrão `true`, mantém o comportamento de sempre
  pras fases 1/2). A fase 3 chama `fill(row, localPhotos, false, false)`
  — `autoSubmit=false` (nunca submete) + `waitForVideoUpload=false`
  (dispara o upload e não bloqueia esperando terminar, só uma pausa
  mínima de 800ms pra garantir que o clique/seleção do arquivo
  realmente registrou antes de trocar de aba).
- Vídeo não é gravado no histórico local (`snow_submitted_rows.json`) —
  só é auto-submetido pelo humano, o robô nunca vê a confirmação final,
  então não tem como marcar "esse foi submetido". A proteção contra
  duplicata pra vídeo numa próxima rodada depende inteiramente da
  auditoria ao vivo (por isso os ajustes de precisão dessa auditoria,
  descritos acima, importam tanto pra vídeo especificamente).
- `RunAutomationResult` ganhou `videosFilled`/`videosFailed`, contados à
  parte de `processed`/`failed` — "preenchido, aguardando revisão manual"
  não é a mesma coisa que "ok" ou "falhou".

## Bug crítico corrigido: seleção de combobox podia "parecer" funcionar sem selecionar nada

Conferindo manualmente o ServiceNow (comparando a tabela ao vivo com a
planilha original), o usuário achou 3 entradas cadastradas na pá **0549**
quando a planilha claramente dizia **0548** pra aquele defeito
específico (Foreign Object, DF 36). Rodou de novo em modo Conferência
Manual (sem autosubmissão, cada linha em aba nova — descartando resíduo
de busca de uma aba compartilhada) e o mesmo erro se repetiu.

Causa raiz: `selectFromComboBox` clicava numa opção candidata e
considerava sucesso só por não ter dado exceção — nunca conferia se o
clique realmente selecionou o valor CERTO. Se nenhum dos seletores em
cascata batesse de verdade com o texto esperado (por qualquer motivo —
timing, texto renderizado diferente do esperado, delay do Select2), o
código só seguia em frente silenciosamente (`.catch(() => {})`),
deixando o campo com o que já estivesse selecionado ali antes (aparenta
ser algum valor lembrado pela sessão/cache do próprio ServiceNow) — e o
resto do formulário continuava sendo preenchido normalmente, sem erro
visível nenhum. Resultado: defeito cadastrado na pá errada, sem log de
falha, só descoberto comparando manualmente com a planilha original.

**Corrigido**: `selectFromComboBox` agora, depois de tentar selecionar,
LÊ DE VOLTA o valor que ficou no campo (`readComboBoxValue`, novo método
— lê o texto do container `.select2-chosen`/`.select2-choice` visível) e
compara com o valor esperado (comparação tolerante, `includes` nos dois
sentidos, pra aguentar truncamento de texto longo). Se não bater:
1. Loga aviso claro e tenta a seleção inteira de novo, do zero.
2. Se AINDA assim não bater depois da retentativa, lança uma exceção —
   aborta essa linha específica com erro claro em vez de seguir
   preenchendo o resto do formulário com dado errado.

Essa verificação vale pra QUALQUER campo de combobox (Blade serial
number, Sub Component, Failure Type, Inside/Outside, Blade section,
sub-section, area, shear web) — todos passam pelo mesmo
`selectFromComboBox`, então todos ganham a mesma proteção.

## Verificação de combobox virou dupla leitura (não só uma)

Achado real: mesmo com a verificação de leitura única (seção acima), um
caso passou — "Blade serial number" foi lido como correto ("0544") no
instante da checagem, mas o valor final que ficou no formulário (visto
manualmente pelo usuário depois de uma falha em "Blade area" na mesma
linha) era outra pá ("0542"). Ou seja: uma condição de corrida — o campo
estava certo no momento da leitura e mudou depois (script client do
ServiceNow, re-render do Select2, ou cascata de outro campo), sob carga
(mesma categoria dos outros dois bugs de timing corrigidos hoje).

**Corrigido**: `selectFromComboBox` agora lê o valor DUAS vezes, com
600ms de intervalo, e só aceita se as duas leituras baterem entre si E
com o valor esperado (`readStable`). Se a leitura mudar entre a primeira
e a segunda (instável) ou não bater com o esperado, conta como falha —
mesmo fluxo de retentativa + abortar linha de antes, só que agora também
pega o caso de "parecia certo, mudou depois".

## Bug corrigido (achado pela nova verificação de combobox): "Blade area" e "Blade shear web" são mutuamente exclusivos

A verificação pós-seleção implementada antes (ver "Bug crítico corrigido")
pegou um erro real na primeira vez que rodou: `[Blade area] Seleção não
confirmada (queria "Shear Web A", ficou "(vazio)")`. Print real do
formulário confirmou a causa — quando "Blade sub-section" é "Shear Web",
o ServiceNow troca o campo "Blade area" pelo campo "Blade shear web" (não
aparecem os dois juntos na tela; visualmente só existe "Blade shear web"
nesse estado). O código sempre tentava preencher "Blade area" de qualquer
jeito, mesmo quando o campo nem existia — antes da verificação existir,
isso passava batido silenciosamente; com ela, corretamente vira erro
(exatamente o comportamento que a verificação deveria ter).

**Corrigido**: `fill()` só tenta selecionar "Blade area" quando "Blade
shear web" NÃO está visível — nesse último caso, o valor já foi
capturado no passo anterior (`selectFromComboBox('Blade shear web', ...)`
usa `data.bladeArea` como valor, já que pra pás com Shear Web a área É o
próprio nome do shear web, ex. "Shear Web A").

## Ajuste: mais paciência ao abrir o formulário na fase de vídeos

Usuário reportou: rodando só vídeos, ao pular pra próxima aba o robô às
vezes retornava "não abriu a tempo" pro Add Damage Entry — pediu pra
MANTER a validação (não removê-la), só dar tempo suficiente antes de
desistir, e checar se o mesmo comportamento acontece fora da fase de
vídeos também.

Explicação provável: na fase de vídeos, abas anteriores podem estar
subindo vídeo ao mesmo tempo (uso pesado de rede/CPU) — uma aba nova
nessa hora demora mais que o normal pra carregar/renderizar, e o
orçamento de tempo que `openDamageEntryForm` dava (~17s no total, somando
todas as etapas) não bastava.

**Ajustado (aplicado nas duas fases, não só vídeo — verificação genérica
de "carga alta pode acontecer em qualquer hora")**:
- Nova espera inicial: `waitForLoadState('networkidle', {timeout: 8000})`
  antes de sair procurando o botão "Add Damage Entry" — dá chance da
  página assentar primeiro.
- Loop de clique: de 12 tentativas × 800ms pra 20 tentativas × 1000ms.
- Espera pelo formulário ficar pronto (1ª rodada): de 5s pra 15s.
- Espera pelo formulário ficar pronto (2ª rodada, depois de retentar o
  clique): nova, adicionada — mais 8s de espera antes de desistir de vez
  (antes só tinha um `waitForTimeout(2000)` fixo, sem re-checar depois).
- Orçamento total foi de ~17s pra ~50s+ antes de considerar que o
  formulário realmente não abriu.

A validação em si (checar se realmente é a tela do formulário, não só
"algo carregou") continua exatamente igual — só ficou mais paciente antes
de desistir.

## Histórico local em JSON removido — planilha virou a única fonte de verdade

Reflexão do usuário sobre o Módulo 23: ter duas fontes de verdade
independentes (o histórico local em JSON de um lado, a tabela ao vivo do
ServiceNow de outro) tanto pode reforçar a robustez quanto pode
atrapalhar — e foi exatamente isso que causou o bug de "histórico
desatualizado" documentado na seção antiga logo abaixo. A saída: parar de
manter um JSON GO à parte e passar a gravar o resultado direto na própria
planilha.

**Implementado**:
- `OUTPUT_HEADERS` em `snowProcessor.ts` (Módulo 23) ganhou uma 17ª
  coluna, **"SNOW Entry #"**, reservada em branco — o Módulo 23 não
  escreve nada nela, só reserva a posição.
- `DamageEntryFiller.fill()` (Módulo 24), depois de um Submit
  bem-sucedido, lê o campo "Number" do formulário recém-criado (label
  EXATA — `exact: true`, já que "Blade serial number" também contém a
  palavra "number" como substring e bateria por engano com
  `exact: false`) e devolve esse valor (ex.: "DAM1115650") pra quem
  chamou.
- `runSnowDamageAutomation` grava esse número na coluna 17 da linha
  correspondente na planilha ORIGINAL (`writeBackEntryNumber`) e SALVA o
  arquivo imediatamente — não em lote no final, pra não perder o
  progresso se a automação for interrompida no meio de um lote grande.
  Precisou de um novo campo `excelRowIndex` em `DamageReportRow` (o
  número da linha na planilha, gravado por `readDamageRows`) pra saber
  em qual linha escrever de volta.
- `readDamageRows` agora checa a coluna 17: se já tem algo escrito, a
  linha é ignorada de cara (nem entra no array de linhas a processar) —
  substitui o antigo filtro por `snow_submitted_rows.json`.
- Removidos: `loadSubmittedRows`, `markRowSubmitted`,
  `clearSubmittedRowsStore`, `buildRowKey`, o handler IPC
  `snow_automation_clear_history`, e o botão "🗑" da UI.

**Limitação aceita (mesma de sempre)**: linhas de vídeo nunca são
auto-submetidas pelo robô (fase 3, sempre manual), então nunca ganham um
número gravado na coluna — a proteção contra duplicata pra vídeo continua
dependendo só da auditoria ao vivo. Planilhas geradas ANTES dessa mudança
(sem a coluna "SNOW Entry #" no cabeçalho) continuam funcionando
normalmente — a leitura/escrita usa a posição da coluna (17), não o texto
do cabeçalho, só fica sem o rótulo bonito até reexportar do Módulo 23.

## Histórico local (snow_submitted_rows.json) pode ficar desatualizado — SEÇÃO ANTIGA, substituída pela de cima

Além da auditoria ao vivo, existe um segundo filtro independente: um
arquivo local (`%APPDATA%/ArthwindSuite/snow_submitted_rows.json`) que
marca linhas já submetidas por ESSA máquina em execuções anteriores. Esse
histórico não é afetado pelos bugs acima (é uma fonte de dados totalmente
separada) — se ele acumulou marcações erradas de testes anteriores (antes
dos bugs serem corrigidos), pode continuar pulando linhas que na verdade
não foram cadastradas. Botão "🗑" na UI (`handleClearHistory` →
`snow_automation_clear_history` → `clearSubmittedRowsStore()`) apaga esse
arquivo — use se o número de linhas puladas não bater com o que realmente
está na tabela do ServiceNow mesmo depois da auditoria ao vivo estar
correta.

## Bug corrigido: defeito real com DF Start = 45 sendo confundido com vídeo na auditoria

`scanCurrentListPage` (a auditoria ao vivo) decidia se um grupo de linhas da
tabela "Damage Report Entries" era um grupo de **vídeo** (DF 45-50, sempre 4
por pá) olhando só pro DF Start: `group[0].dfVal === '45'`. Só que DF 45
também é um valor válido pra um defeito comum (foto), e nada impede um
defeito real de cair exatamente nesse DF por coincidência.

Em teste real apareceram 2 DAMs (DAM1118234, DAM1118235) que eram defeitos
de verdade em DF 45 — não vídeos. A auditoria os tratava como grupo de
vídeo e entrava no fluxo de desambiguação por anexo, que fica ~15s
(30 tentativas x 500ms) procurando um `.mp4` que nunca existiria, porque
esses DAMs não têm anexo de vídeo nenhum. Além do tempo desperdiçado, esses
defeitos nunca eram confirmados como "já cadastrado" pela auditoria (o
ramo de vídeo só grava chaves qualificadas por Section/Area, que um
defeito comum nunca vai bater), arriscando reprocessamento indevido.

**Causa raiz**: o que realmente identifica uma linha de vídeo não é o DF,
é o Failure Type — todo vídeo tem sempre o mesmo valor fixo, "Type of
failure is missing" (gravado assim pelo Módulo 23). Um defeito comum em
DF 45 tem um Failure Type diferente (ex.: "Delamination", "Air
inclusions" etc.).

**Fix**: `isVideoDf` agora exige os dois critérios juntos:

```ts
const isVideoDf = group[0].dfVal === '45' && group[0].failureNorm === 'type of failure is missing'
```

(`failureNorm` já vinha sendo calculado por linha via `normalizeFailureType`
pra outros fins — só precisou ser propagado pro tipo `RowInfo` e pro
`isVideoDf`.) Grupos que não batem os dois critérios seguem o caminho
normal de defeito (chave direta, sem leitura de anexo).

## Debug: log das chaves calculadas pelo lado da tabela ao vivo

Já existia um log `🔎 [debug] Vai processar: ... — chaves: ...` mostrando as
chaves que a auditoria monta a partir da PLANILHA. Não existia o
equivalente do lado da tabela ao vivo do ServiceNow — quando uma linha
já cadastrada continuava marcada como "pendente", não dava pra saber se a
chave lida ao vivo ficou diferente da esperada (Sub Component/Failure
Type com texto levemente diferente, DF lido de coluna errada etc.) sem
adivinhar. Adicionado `🔎 [debug] Já na tabela ao vivo: chave "..."` em
`scanCurrentListPage`, logado pra toda linha não-vídeo já reconhecida
como cadastrada — dá pra comparar os dois lados direto no log.

## Bug corrigido: fila overnight ignorava mudança de "Submeter automaticamente" feita depois de montar a fila

`headless`, `autoSubmit` e as 3 categorias (Defeitos/Blanks/Vídeos) são
configurações GLOBAIS — um único checkbox no painel esquerdo, não um
campo por turbina da fila. Mas `handleAddToQueue` gravava o valor desses
campos DENTRO do item no momento do clique em "➕ Adicionar à fila"
(`options: buildOptions()`), e `handleRunQueue` usava esse snapshot
congelado (`item.options`) na hora de rodar.

Fluxo típico que disparava o bug: montar a fila inteira com várias
turbinas primeiro, e só depois marcar "Submeter formulário
automaticamente" como último passo antes de clicar em "Rodar fila
overnight" — a marcação era ignorada silenciosamente, e toda turbina da
fila rodava em modo Conferência Manual (o valor que estava no checkbox
quando cada item foi adicionado, geralmente `false`, o padrão).

**Fix**: `handleRunQueue` agora monta as opções de cada rodada como
`{ ...item.options, headless, autoSubmit, includeDefects, includeBlanks,
includeVideos }` — os campos globais vêm sempre do estado ATUAL do
checkbox, só `startRow`/`endRow` (esses sim por turbina) continuam vindo
do snapshot do item.

## Textos explicativos abaixo dos checkboxes de Submissão/Categorias removidos

A pedido do usuário — não eram mais necessários depois das correções
acima (o texto sobre "histórico local" já tinha sido corrigido antes,
mas o pedido era remover os blocos inteiros, não só ajustar o texto).

## Bug corrigido: fila overnight misturava turbina com a página da turbina anterior (Submissão Automática)

Com "Submeter formulário automaticamente" ligado, o robô reaproveita uma
aba já aberta do navegador em vez de abrir uma nova a cada linha
(`context.pages().find((p) => !p.isClosed())` — ver comentário no
código sobre por que isso é intencional só nesse modo). Antes de
preencher, checava se já estava na página certa comparando só a base da
URL, sem a query string: `targetPage.url().includes(incidentUrl.split('?')[0])`.

Só que a URL do Inspection Report no ServiceNow é a MESMA base pra
qualquer incidente (`.../inspection_report.do`) — o que muda entre
turbinas é o `sys_id` na query string. Rodando a fila overnight com 2+
turbinas, a aba reaproveitada da turbina anterior "parecia" já estar no
lugar certo pra turbina seguinte (mesma base, `sys_id` diferente) e
NUNCA navegava pra URL nova — a automação seguia preenchendo os dados da
turbina 2 em cima da página ainda aberta da turbina 1, travando na
seleção do Blade serial number (a pá da turbina 2 não existe no
Inspection Report da turbina 1, então a verificação dupla de combobox —
ver seção "Verificação de combobox virou dupla leitura" mais acima —
corretamente nunca conseguia confirmar a seleção e acabava travando/
falhando ali).

**Fix**: a checagem agora compara a URL INTEIRA (`targetPage.url() !==
incidentUrl`), não só a base antes do `?` — garante que toda troca de
turbina force uma navegação de verdade pra URL certa antes de preencher
qualquer coisa.

## Modo Auditoria (dry run)

Pedido do usuário: uma forma de só CONFERIR o que falta na planilha em
relação ao que já está no ServiceNow, sem preencher nem abrir formulário
nenhum — útil pra checar rápido antes de decidir se vale a pena rodar a
automação de verdade.

**Implementado**: nova opção `dryRun` em `RunAutomationOptions`. Roda
exatamente a mesma sequência de sempre — leitura da planilha, auditoria
ao vivo do ServiceNow (`auditLiveDamageEntries`), todos os filtros
(pás selecionadas, categorias, já cadastrado ao vivo, Blank Image por
contagem) — e só PÁRA logo antes da Fase 1 (o loop que efetivamente abre
"Add Damage Entry" e preenche). Como é a mesma lógica de filtragem de uma
execução real, a precisão do relatório é idêntica à de uma auditoria que
de fato reprocessaria essas linhas.

Loga um resumo (contagem por categoria) e a lista detalhada de cada linha
faltando (pá, sub component, failure type, DF), e devolve o resultado com
`dryRun: true` + `missingDefects`/`missingBlanks`/`missingVideos` em vez
de preencher qualquer coisa.

Novo checkbox "Modo Auditoria (dry run)" no painel — quando marcado,
desabilita e ignora visualmente o checkbox "Submeter automaticamente"
(não faz sentido os dois juntos, dry run nunca preenche nada pra
submeter). Também passa pela fila overnight, do mesmo jeito que
`autoSubmit`/categorias (usa o valor ATUAL do checkbox no momento de
cada turbina rodar, não um snapshot congelado — ver seção da fila
overnight mais acima).

## Pacote standalone (CLI) pro time de dev

Pedido do usuário: uma versão da automação que o time de dev pudesse
rodar/revisar separada do Arthwind Suite (sem precisar abrir o app
inteiro), continuando a existir normalmente dentro da Suite também.
Empacotado como um script Node/TypeScript simples (`run.ts`), sem
Electron/React — só a lógica de `snowAutomation.ts` +
`snowProcessor.ts` (usado só pela `SnowMappings`) + as duas
dependências que `snowProcessor.ts` puxa (`polygonUtils.ts`,
`bladeSets.ts`), chamado via linha de comando. Ver `README.md` do
pacote pra instruções de uso (inclui o modo `--dry-run`).

## Bug corrigido: auditoria via Modo Auditoria (dry run) via undercontava a lista — não paginava/rolava direito

Achado testando o Modo Auditoria numa turbina real: o dry run reportou 19
itens faltando (13 defeitos, 2 blanks, 4 vídeos), mas o usuário confirmou
direto no ServiceNow que as **39 entradas já existiam de verdade** (batendo
exatamente com as 39 linhas da planilha) — as duas rodadas anteriores
tinham sido em modo Submissão Automática, então já tinham sido
efetivamente cadastradas. O log mostrava só "Página 1 da lista lida (+16
entrada(s))" e nunca tentava uma página 2.

**Causa raiz**: `scanDamageEntriesTableByColumn` sempre dependeu de
`goToNextListPage` achar um botão de paginação clássico ("Rows 1-20 of
X", setas `<`/`>`) pra ler o resto da lista além da primeira leva de
linhas. Essa tela específica do ServiceNow é um widget Angular (Service
Portal) — não usa paginação por botão, e sim carrega/renderiza mais
linhas conforme a página é rolada (scroll infinito ou virtualização).
Sem um botão de "próxima" pra clicar, `goToNextListPage` sempre devolvia
`false` de cara, e a auditoria parava depois de ler só as linhas já
renderizadas na carga inicial (16 de 39) — tratando as outras 23 como
"faltando", quando na verdade só estavam invisíveis por nunca ter
rolado a tela pra baixo.

(Nota: existia uma tentativa antiga de resolver algo parecido —
`growListUntilStable`, removida numa sessão anterior porque na época a
causa raiz de um sintoma parecido era outra, colisão de chave de
auditoria, não rolagem. Dessa vez a evidência é direta — contagem real
no ServiceNow confirmada pelo usuário —, então a hipótese de rolagem
voltou, mas com log explícito desta vez.)

**Fix**: nova função `growVisibleRowsUntilStable(page, log)`, chamada
antes de cada leitura de página em `scanDamageEntriesTableByColumn`.
Rola até a última linha de qualquer `<table>` da tela (via
`scrollIntoViewIfNeeded`, que funciona tanto pra rolagem da janela
inteira quanto de um container interno) e reconta as linhas depois de
cada rolagem — repete até a contagem parar de crescer por duas leituras
seguidas (ou até um teto de segurança de 60 rolagens). Só depois disso
`scanCurrentListPage` lê a página de verdade.

Também adicionado log explícito em `goToNextListPage` quando nenhum
controle de "próxima página" é encontrado, ou quando é encontrado mas
desabilitado — antes esse caso ficava totalmente silencioso, sem pista
nenhuma no log de qual dos dois motivos fez a auditoria parar de
avançar.

## Bug corrigido: "Type of failure is missing" não é exclusivo de vídeo — causava duplicata

Reportado pelo usuário direto de um teste real: uma linha (DAM1119918)
entrava no fluxo de desambiguação de vídeo (DF 45 + Failure Type "Type
of failure is missing"), gastava os 15s inteiros de timeout tentando
achar um anexo `.mp4` que nunca existiria, e nunca era marcada como já
cadastrada — arriscando duplicata no reprocessamento seguinte.

**Causa raiz**: o texto fixo "Type of failure is missing" NÃO é usado só
pelas linhas de vídeo — `SnowMappings.FAILURE_TYPES` (Módulo 23) também
mapeia vários defeitos de FOTO pro mesmo texto (`'Bonding paste
failure'`, `'LPS Disconnected/Damaged'`, `'Damaged Laminate'`, entre
outros — ver o mapeamento completo em `snowProcessor.ts`). Um desses
defeitos de foto, caindo por coincidência em DF 45, bate nos dois
critérios de `isVideoDf` e entra no fluxo de vídeo à toa — só que, sendo
foto, nunca vai ter um anexo `.mp4` pra encontrar.

**Fix**: `readRowAttachmentFilename` virou `readRowAttachmentKind`,
que agora reconhece TRÊS resultados em vez de só vídeo-ou-nada:
- `{ kind: 'video', filename }` — achou `.mp4`, desambigua o quadrante
  normalmente (como já era).
- `{ kind: 'photo' }` — achou anexo `.jpg`/`.jpeg`/`.png` em vez de
  vídeo — confirma que é um defeito de foto comum, não vídeo. Marca
  pela chave normal (`baseKey`, sem qualificação de Section/Area),
  igual ao caminho não-vídeo — resolve rápido (assim que o anexo de
  foto aparece), sem esperar os 15s inteiros de timeout.
- `{ kind: 'unknown' }` — nem vídeo nem foto apareceram a tempo
  (comportamento antigo) — continua conservador, não marca nada.

## Feature: confirmação de upload de vídeo + retentativa automática (Fase 3)

Pedido do usuário: depois de preencher os formulários de vídeo (Fase 3,
cascata de abas), o robô deveria voltar e CONFERIR se cada upload de
verdade terminou — não só se os campos foram preenchidos (isso é
síncrono e sempre "dá certo") — e reprocessar sozinho qualquer vídeo
cujo upload não confirmar, sem deixar nada pendente pra checagem manual
depois. Motivação explícita: numa fila overnight, sem ninguém olhando,
um upload que falha silenciosamente (rede lenta, timeout do ServiceNow)
só seria percebido de manhã, abrindo aba por aba na mão.

**Antes**: Fase 3 preenchia cada vídeo numa aba nova, disparava o
upload sem esperar (`waitForVideoUpload=false`), contava como
"preenchido" e seguia pro próximo — nunca verificava se o arquivo
realmente terminou de subir.

**Depois — duas passadas por rodada**:
1. **3a (preenche)**: abre uma aba por vídeo da rodada, preenche e
   dispara o upload de todas ANTES de conferir qualquer uma — preserva
   o ganho de tempo da cascata (uploads correndo em paralelo enquanto
   as próximas abas ainda estão sendo preenchidas).
2. **3b (confere)**: só depois de abrir todas as abas da rodada, passa
   por cada uma chamando a nova função `verifyVideoAttached(formPage,
   expectedFilename, log)` — espera (até 180s, mesmo timeout de
   `waitForAttachmentUploaded`) o nome do arquivo de vídeo aparecer
   como anexo de verdade no formulário. Se não confirmar, descarta a
   aba e marca a linha pra reprocessar.

Linhas que não confirmaram voltam pra uma nova rodada de 3a+3b — até
`MAX_VIDEO_ROUNDS = 3` no total, mesmo padrão de retentativa já usado
na Fase 1 (Defeitos/Blanks). Como os dados já foram preenchidos pelo
menos uma vez, reprocessar é seguro: se por acaso a linha tiver sido
submetida por engano nesse meio tempo, a auditoria ao vivo do início da
rodada seguinte já teria pego isso via `checkRowExistsInLiveTable`. Só
depois de esgotadas as 3 rodadas um vídeo é finalmente reportado como
falha de verdade (`videosFailed`) — o objetivo é que, ao fim da
execução (individual ou overnight), nenhum vídeo fique num estado
"talvez preenchido, talvez não" exigindo alguém abrir a aba pra
descobrir.

`videosFilled` mudou de significado: antes contava "formulário
preenchido", agora conta "upload CONFIRMADO" — mais preciso, já que o
upload em si é assíncrono e pode falhar sem gerar erro nenhum visível
no preenchimento em si.

## Feature (em teste): Fase 0 — Create Inspection Report

Pedido do usuário: estender a automação pra cobrir a etapa ANTES do
Damage Report Entry — o INC já vem criado de antemão pela NAWP, mas
existe um formulário de cabeçalho da inspeção ("Create Inspection
Report", separado do cadastro de danos) que precisa existir e estar
submetido antes da tela de Damage Report Entries ficar acessível. Hoje
isso é preenchido na mão; a ideia é rodar do início ao fim sem
intervenção manual, exceto o nome de quem está rodando (sempre
variável).

Mapeamento de dados fechado em conversa com o usuário (screenshots do
fluxo real do ServiceNow + PDF/planilha de controle da campanha):

**Fixos pra toda a campanha** (`INSPECTION_REPORT_FIXED` em
`snowAutomation.ts`): Access method = "Visual inspection: Other",
Blade type = "NR81.5" (não "NR81.5 - AI-D", que também existe no
dropdown), Purchase Order = "0000000014", Blade manufacturing location
= vazio, único checkbox marcado = "Safety checklist read and
followed" (drain hole A/B/C, ruído atípico, peças soltas, vácuo,
"Blade Inside Inspection completed?" ficam desmarcados).

**Por turbina, via `blade_sets.json`** — nova função
`getBladesForTurbine(wtg)` em `bladeSets.ts`: filtra por
`turbinePrefix` (não por `turbine`, que na lista vem como uma string
combinada tipo "VSR03-01-90626") e ordena por `component` ("Rotor
blade 1/2/3" — assume-se 1→Blade A, 2→Blade B, 3→Blade C; ordem ainda
não confirmada contra o formulário real). Cobre Blade A/B/C serial
number E Blade set number (os 4 últimos dígitos do serial, mesmo valor
pras 3 pás) numa chamada só.

**Por turbina, via planilha de controle** — nova função
`readTurbineIncList(xlsxPath)`: lê a planilha "Status Envio ServiceNOW
- <cliente>.xlsx" (aba "Turbinas"), colunas WTG/Turbina ID/INC
(SNOW)/Data Coleta nas 4 primeiras posições. `Data Coleta` alimenta
"Inspection Start Date" — reformatada de `Date` do ExcelJS pra
DD/MM/YYYY quando a célula vem como data de verdade (não texto).

**Runtime**: "Responsible technicians" — digitado por quem roda, nunca
vem de arquivo.

### Peças novas

- `ServiceNowFormFiller` — classe base extraída de `DamageEntryFiller`
  (que virou `DamageEntryFiller extends ServiceNowFormFiller`), com
  `selectFromComboBox`/`fillText`/`getScope` (já existiam) mais dois
  métodos novos: `setCheckbox(fieldLabel, checked)` e `submitForm()`
  (também extraído do bloco de submit que só existia dentro de
  `DamageEntryFiller.fill`). Motivo: o Inspection Report usa os mesmos
  widgets Select2/checkbox/submit do ServiceNow — sem essa extração
  seria ~150 linhas de lógica de combobox duplicadas.
- `InspectionReportFiller extends ServiceNowFormFiller` — preenche e
  submete o formulário novo com o mapeamento acima.
- `findAndOpenIncident(page, portalOrigin, incNumber, log)` — navega
  portal → tile "My Inspection Reports" → lista "Technical Incidents"
  → pesquisa → clica no resultado.
- `detectInspectionReportState(page, log)` — devolve `'create' |
  'show' | 'unknown'` lendo qual botão de Ações aparece.
- `ensureInspectionReport(page, portalOrigin, entry, technician, log)`
  — orquestra as duas funções acima + o preenchimento, pra 1 turbina.
- `runInspectionReportPhase(controlXlsxPath, portalOrigin, technician,
  options, log)` — lê a planilha de controle inteira (ou um filtro por
  `onlyIncNumbers`, pra testar com 1 turbina) e roda
  `ensureInspectionReport` pra cada uma, uma aba por vez.

### IPC + UI

Novos canais: `snow_read_turbine_inc_list` (preview da planilha de
controle) e `snow_inspection_report_run` (roda a Fase 0). Nova seção
"Fase 0 — Create Inspection Report" no topo do painel esquerdo de
`SnowAutomationModule.jsx`: seletor da planilha de controle, campo de
URL do portal, campo "Responsible technicians", e dois botões —
"Testar 1ª turbina" (só a primeira linha da planilha, pensado pra
conferir visualmente antes de rodar tudo) e "Rodar planilha inteira".

### Ainda não confirmado contra o ServiceNow real

Implementado e com typecheck limpo, mas **nenhum seletor foi
confirmado rodando contra o ServiceNow de verdade ainda** — mesmo
processo iterativo que todo o resto do Módulo 24 passou (selectors
"prováveis" primeiro, corrigidos depois do primeiro teste real):

- Texto/seletor exato dos botões "Create Inspection Report" / "Show
  Inspection Report" e do tile "My Inspection Reports" na home do
  portal.
- Se existe uma URL estável pra pular direto pra "Technical Incidents"
  (evitaria o clique a cada turbina).
- Se o campo "Inspection Start Date" aceita digitação direta no
  formato DD/MM/YYYY ou exige o date picker.
- Ordem real de "Rotor blade 1/2/3" → "Blade A/B/C" no formulário.

Próximo passo: rodar "Testar 1ª turbina" com o navegador visível
(headless desligado) contra um INC real e corrigir o que não bater.

## Bug corrigido: "Rodar planilha inteira" batia erro em turbina já avançada

Testando com a planilha de controle REAL da campanha (74 turbinas):
74% delas (Estado de Inspeção) já tinham o relatório completo enviado,
e 34 dessas 74 já tinham "Status SNOW (Cliente)" = "Enviado com/sem
Correção" — ou seja, o defeito JÁ foi submetido ao ServiceNow pro
cliente. Rodar a Fase 0 pra essas turbinas batia em "INC não apareceu
na busca de Technical Incidents" — não é um erro de verdade, é só que
o INC já passou dessa etapa e não aparece mais buscável do mesmo jeito
nessa tela.

**Causa raiz**: se o defeito já foi enviado (Status SNOW = "Enviado..."),
o Inspection Report *necessariamente* já existe — é pré-requisito lógico
pra sequer conseguir cadastrar um defeito (não dá pra chegar na tela de
Damage Report Entries sem passar pelo Inspection Report antes). Rodar a
Fase 0 de novo pra essas turbinas era sempre desnecessário — e o
resultado "não encontrado" ficava misturado com falhas de verdade, sem
distinção nenhuma.

**Fix**:
- `TurbineIncEntry` ganhou o campo `statusSnow` (coluna H, "Status SNOW
  (Cliente)").
- Nova função `isAlreadySentToClient(statusSnow)` — testa se o texto
  começa com "Enviado" (cobre "Enviado com Correção" e "Enviado sem
  Correção").
- `runInspectionReportPhase` filtra essas turbinas ANTES de tentar
  buscar qualquer coisa (opção `skipAlreadySent`, padrão `true`) — loga
  quantas foram puladas e por quê, sem contar como falha.
- UI: checkbox "Pular turbinas com Status SNOW já 'Enviado...' na
  planilha de controle", marcado por padrão.
- "Testar 1ª turbina" também mudou: agora pega a primeira turbina
  REALMENTE pendente (não a linha 1 da planilha, que podia já estar
  enviada) — testar numa já enviada só validaria o caminho "Show
  Inspection Report", não o preenchimento de verdade.

## Bug corrigido: `findAndOpenIncident` não esperava o portal Angular renderizar

Primeiro teste real: nem o tile "My Inspection Reports" nem a caixa de
busca "Keyword Search" foram encontrados — as duas checagens falharam
quase instantaneamente, sem dar tempo nenhum da página carregar de
verdade.

**Causa raiz**: `page.goto(portalOrigin, { waitUntil: 'domcontentloaded' })`
+ 1 segundo fixo de espera, seguido de UMA checagem `isVisible({timeout:
5000})` — mas o portal do ServiceNow é um app Angular (Service Portal),
que pode levar bem mais que isso pra bootar e desenhar os componentes de
verdade (o DOM "carrega" antes do Angular sequer começar a rodar). Mesmo
padrão de causa raiz já visto antes na lista "Damage Report Entries"
(ver seção "Bug corrigido: auditoria via Modo Auditoria... só rolagem" —
componente Angular, timing imprevisível).

**Fix**: nova função `waitVisibleWithRetry(locator, attempts=12,
intervalMs=1000)` — tenta achar o elemento várias vezes com intervalo
(até ~12s), em vez de uma única checagem. Aplicada nas 3 esperas de
`findAndOpenIncident` (tile, caixa de busca, resultado da pesquisa).
Também trocado `domcontentloaded` por `networkidle` nos `waitForLoadState`
depois de cada navegação/clique, mesmo padrão de paciência já usado em
`openDamageEntryForm` pro resto do módulo.

## Feature: Automação Completa — Fase 0 + Módulo 24 numa passada só

Pedido do usuário depois de confirmar que a Fase 0 isolada funcionava: unir
as duas etapas. A lógica certa é acha o INC → se "Show", só sobe os
defeitos; se "Create", preenche o Inspection Report primeiro e DEPOIS sobe
os defeitos — tudo numa passada, sem pedir uma segunda URL (já se tem a
URL do portal e o número do INC, o link específico do Damage Report é
achado sozinho navegando).

Também pedido: usar as pastas locais já geradas pelo Módulo 23
(`D:\SNOW\WTG'S\<WTG>\<WTG>_Novo_Excel.xlsx` + `Fotos\`) pra saber quais
turbinas pendentes na planilha de controle já têm defeito pronto pra
subir, com opção de rodar tudo que estiver pronto ou só a próxima da
planilha.

### Peças novas

- `scanWtgFolders(rootDir)` — varre a pasta raiz atrás de subpastas com
  `..._Novo_Excel.xlsx` dentro (confirma que o Módulo 23 já processou essa
  turbina). Não lê conteúdo, só localiza os caminhos (Excel + `Fotos\`, se
  existir).
- `normalizeWtg(s)` — acerta a diferença de formato achada inspecionando a
  pasta real: `D:\SNOW\WTG'S` usa `VSR-19-04` (hífen extra), a planilha de
  controle usa `VSR19-04` (sem). Remove tudo que não é letra/número dos
  dois lados antes de comparar, sem precisar decidir qual formato é "o
  certo".
- `runFullAutomation(controlXlsxPath, wtgRootFolder, portalOrigin,
  technician, options, log)` — por turbina: `findAndOpenIncident` →
  `detectInspectionReportState` → `clickInspectionReportButton` → (se
  `'create'`) preenche e submete o Inspection Report → captura `page.url()`
  (é a URL que o Módulo 24 já espera receber) → chama
  `runSnowDamageAutomation(folder.excelPath, page.url(), ...)` sem mudar
  nada dentro dele. `runSnowDamageAutomation` e todo o resto do Módulo 24
  ficam intocados — só passam a receber a URL descoberta automaticamente em
  vez de digitada.
- `options.mode`: `'all'` processa toda turbina pendente com pasta pronta;
  `'next'` processa só a primeira da planilha de controle (nessa ordem)
  que estiver pendente e com pasta pronta — pra testar uma de cada vez
  antes de soltar o lote inteiro.

### UI

A seção "Fase 0" virou **"Automação Completa"**: ganhou um seletor de
pasta raiz (`D:\SNOW\WTG'S`), e os botões viraram **"Rodar próxima
pendente"** / **"Rodar todas as prontas"**. Não pede mais nenhuma URL de
Damage Report — só a URL do portal (já vem pré-preenchida), a planilha de
controle, a pasta raiz e o nome do técnico.

O formulário manual antigo (Planilha SNOW / Pasta de Fotos / URL do
Inspection Report / seleção de pás / fila overnight) continua existindo
sem mudança nenhuma, abaixo dessa seção — é o caminho manual pra rodar uma
turbina específica fora do fluxo automático (ex.: reprocessar algo pontual).

## Bug corrigido: URL capturada logo após o Submit não era a página certa

Primeiro teste real da Automação Completa: o Inspection Report preenchia e
submetia certinho ("✓ Inspection Report submetido."), mas a auditoria do
Módulo 24 logo em seguida nunca achava a tabela "Damage Report Entries" —
"Add Damage Entry" nunca abria o formulário, e as linhas falhavam com
"Target page, context or browser has been closed".

**Causa raiz**: confirmado pelo usuário com print da tela real — "Create
Inspection Report" é um formulário de CATÁLOGO do ServiceNow. Depois do
Submit, o ServiceNow processa a requisição antes de carregar a página de
verdade do Inspection Report (a que já tem "Add Damage Entry" disponível).
`InspectionReportFiller.fill()` só esperava `networkidle` + 1s fixo depois
do Submit — tempo insuficiente — e `runFullAutomation` capturava
`page.url()` logo em seguida, pegando a URL de uma tela intermediária (de
processamento/confirmação), não a do Inspection Report de verdade.

**Fix**: depois do Submit, `InspectionReportFiller.fill()` agora espera de
verdade o botão "Add Damage Entry" aparecer na página (via
`waitVisibleWithRetry`, até ~30s) antes de considerar a submissão
concluída e devolver `true`. Só depois disso `runFullAutomation` captura
`page.url()` — garantindo que é a página certa pro Módulo 24 continuar.

## Bug de distribuição corrigido: instalador dependia de Playwright instalado na máquina de quem recebe

Achado pelo usuário: o Chromium que o Playwright usa pra automação NÃO é
baixado junto com o `npm install` normal — ele vai pro cache global do
usuário (`%LOCALAPPDATA%\ms-playwright`), fora do projeto, e por isso NUNCA
foi incluído no instalador. Rodando o `.exe` numa máquina que nunca rodou
`npx playwright install` antes, a automação SNOW falharia ao tentar abrir o
navegador — o instalador não era de verdade standalone.

**Fix**: reinstalado o Chromium com `PLAYWRIGHT_BROWSERS_PATH=0` (variável
de ambiente que o Playwright reconhece pra instalar dentro de
`node_modules/playwright-core/.local-browsers` em vez do cache global) —
esse caminho já é empacotado no instalador do mesmo jeito que o `sharp`
(dependência nativa) já era, só precisou adicionar
`node_modules/playwright-core/.local-browsers/**` no `asarUnpack` do
`electron-builder.yml` (executável não roda de dentro do `.asar`).
`chromium_headless_shell` (baixado automaticamente junto, ~270MB) foi
apagado antes do build — o código sempre usa o Chromium normal, tanto
headed quanto headless, nunca esse build alternativo.

**Verificado de verdade**: renomeado temporariamente o cache global
(`ms-playwright` → `ms-playwright_DISABLED_TEST`) e rodado
`chromium.launch()` isolado — lançou normal mesmo sem o cache global
existir, confirmando que vem mesmo do caminho empacotado, não por
coincidência de já estar instalado na máquina de dev.

**Efeito colateral aceito**: o instalador cresceu de ~111MB pra ~243MB
(Chromium comprimido). Não tem como evitar — é o preço de não depender de
mais nada instalado na máquina de quem recebe.

**⚠️ Nota pra builds futuros**: se `node_modules` for reinstalado do zero
(`npm install` limpo, clone novo, etc.), o Chromium volta a ser baixado no
cache global por padrão — antes do próximo `npm run build:win`, rodar:
```powershell
$env:PLAYWRIGHT_BROWSERS_PATH = "0"
npx playwright install chromium
Remove-Item -Recurse -Force node_modules\playwright-core\.local-browsers\chromium_headless_shell-*
```
Sem isso, o instalador volta a depender do Playwright já estar instalado
na máquina de quem recebe.

## Bug corrigido: Automação Completa nunca repassava autoSubmit/categorias/dryRun

Reportado pelo usuário: marcar "Submeter formulário automaticamente" não
fazia diferença nenhuma rodando pela Automação Completa.

**Causa raiz**: `handleRunFullAutomation` (UI) montava as opções de
`snow_full_automation_run` sem incluir `moduleOptions` nenhum —
`{ headless, skipAlreadySent, mode }`, só isso. `runFullAutomation` repassa
`options.moduleOptions` direto pro `runSnowDamageAutomation` de cada
turbina; sem esse campo, `autoSubmit` sempre caía no padrão (`false`),
mesmo com a caixa marcada na tela — o checkbox e a fila overnight tinham
esse mesmo tipo de bug corrigido antes (ver seção "fila overnight ignorava
mudança de Submeter automaticamente" mais acima), mas a Automação Completa
era um caminho novo que nunca tinha essa conexão feita.

**Fix**: `handleRunFullAutomation` agora inclui `moduleOptions: {
autoSubmit, includeDefects, includeBlanks, includeVideos, dryRun }`
(mesmos estados já usados pelo formulário manual mais abaixo na tela).

## Bug intermitente corrigido: clique acertava a foto já anexada, abrindo aba nova

Reportado pelo usuário — raro, "de vez em quando": o robô clicava na
FOTO que já tinha sido anexada (não no botão de adicionar), abrindo uma
aba nova do Chromium com a imagem. Essa aba nova passava a ser tratada
como se fosse a aba do formulário — fechando manualmente, o robô dizia
"instância fechada" e pulava a linha; deixando aberta, ele travava sem
conseguir avançar.

**Causa raiz**: o seletor de fallback do botão "Add attachments" em
`uploadPhotos` era largo demais —
`scope.locator('a, button', { hasText: /attachment/i })` casa com
QUALQUER link/botão cujo texto contenha a palavra "attachment", não só o
botão de adicionar. Só dava problema depois que a 1ª foto de uma linha já
tinha subido e aparecia anexada na tela (daí o "de vez em quando") — a
partir daí, esse seletor largo às vezes casava com o link/legenda da
própria foto já anexada em vez do botão de adicionar a próxima.

**Fix**:
- Seletor apertado pra exigir "add" JUNTO com "attachment" no texto
  (`/add attachments?/i`), não só a palavra solta — não bate mais com um
  anexo já existente.
- Rede de segurança adicional: depois do clique, se uma aba nova
  inesperada abriu (esse clique NUNCA deveria abrir aba — só o seletor de
  arquivo nativo do sistema, capturado via `filechooser`), ela é fechada
  na hora, antes que o resto do código tenha chance de pegá-la por engano
  como se fosse a aba do formulário. Cobre esse bug específico E qualquer
  variação parecida que apareça no futuro.

## Bug corrigido: auditoria "não conseguiu acessar" logo depois da Fase 0

Reportado pelo usuário: rodando a Automação Completa, às vezes a auditoria
ao vivo do Módulo 24 dizia que não conseguiu acessar a página, logo depois
da Fase 0 (Inspection Report) terminar — sem nenhum erro visível na Fase 0
em si, ela só parava de conseguir auditar e já ia direto preenchendo os
defeitos sem confirmar o que já existia.

**Causa raiz** (diagnosticado pelo usuário): `runFullAutomation` fecha a
aba da Fase 0 (`await page.close()`) e chama o Módulo 24 logo em seguida.
O Módulo 24 pega "a primeira página não-fechada" do contexto pra fazer a
auditoria (`auditContext.pages().find((p) => !p.isClosed())`) — mas
`page.close()` pode resolver antes do Playwright/CDP terminar de remover
a página de `context.pages()` de fato (mais visível no Windows). Nessa
janela de tempo, a página que acabou de ser fechada ainda podia aparecer
como "não fechada" — e o Módulo 24 tentava usar exatamente ELA.

**Fix**: depois do `page.close()`, `runFullAutomation` agora espera de
verdade `page.isClosed()` virar `true` (até 3s, checando a cada 100ms) e
ainda soma uma folga de 300ms antes de chamar o Módulo 24 — dá tempo do
fechamento se propagar de verdade antes de qualquer coisa tentar pegar
uma página do contexto.

## Bug corrigido: link "Damage Report Entries" não achado — Related Lists carrega via AJAX

Depois do fix acima, a auditoria ainda falhava com "NÃO encontrou a
tabela 'Damage Report Entries'" mesmo em turbinas onde o Inspection
Report já existia ("Show"). Print do usuário confirmou: a seção
"Related Lists" com o link "Damage Report Entries" (badge mostrando a
contagem, ex.: "19") existe de verdade rolando até o fim da página — não
é um problema de página errada.

**Causa raiz**: `navigateToDamageEntriesList` rolava até o fim UMA vez e
esperava só 800ms fixos antes de checar de novo — insuficiente. A seção
"Related Lists" carrega via AJAX DEPOIS do resto do formulário já estar
visível (a contagem ao lado de cada lista vem de uma chamada separada do
ServiceNow) — em páginas mais pesadas (como essa, com vários campos e
anexos), 800ms não é tempo suficiente pra essa chamada terminar.

**Fix**: troca o scroll-e-espera-uma-vez por um loop de até 12 tentativas
(rola + espera 1s + tenta achar o link de novo), ~12s de paciência total
— mesmo padrão já usado em `findAndOpenIncident` pra esperar o portal
Angular renderizar.

## Ainda investigando: link achado mas auditoria continua sem confirmar

Testado com a 1.9.6 (mais paciência) — o mesmo aviso "NÃO encontrou a
tabela" continuou aparecendo, na mesma turbina. A paciência sozinha não
era o problema (ou não era o único).

**Nova hipótese**: `tryClick` usava `.first()` — se o texto "damage
report entries" aparece em MAIS de um lugar na página (ex.: duplicado em
algum elemento decorativo, ou um `<span>` de contagem separado do link
de verdade), o clique podia "funcionar" (sem erro nenhum, elemento
visível, clique aceito) sem navegar a lugar nenhum — porque o elemento
clicado não era o link de verdade.

**Mudança (ainda não confirmada contra o ServiceNow real)**:
`navigateToDamageEntriesList` agora testa TODAS as ocorrências do texto
em cada escopo (não só a primeira), e só considera sucesso se a URL da
página realmente mudar depois do clique — clique que não navega é
descartado e a próxima ocorrência é tentada. Nas últimas 3 das 15
tentativas de scroll, loga quantas ocorrências foram achadas em cada
escopo e se algum clique não resultou em navegação — se ainda falhar,
o próximo log vai trazer esse diagnóstico detalhado em vez do mesmo
aviso genérico de sempre.

## Bug corrigido: aba de checagem de login ficava aberta e era pega por engano na auditoria

Reportado pelo usuário: durante "Realizando auditoria ao vivo...", o
Chromium "fechou a janela" e ficou tentando auditar pela home do portal
do ServiceNow, não pelo Inspection Report da turbina.

**Causa raiz**: `runFullAutomation` abre uma aba (`authPage`) só pra
confirmar que a sessão está logada, navegando ela pra `portalOrigin`
(home do portal) — mas nunca fechava essa aba depois. Ela ficava aberta
o resto da execução inteira, sobrevivendo a TODAS as turbinas. O Módulo
24, ao montar sua própria auditoria, pega "a primeira página
não-fechada" do contexto (`auditContext.pages().find((p) =>
!p.isClosed())`) — e podia acabar pegando exatamente essa `authPage`
esquecida (ainda na home do portal) em vez de abrir uma página nova de
verdade. Fechar a aba da Fase 0 de uma turbina, nesse cenário, deixava
só a `authPage` visível — dando a impressão de "fechou a janela e voltou
pra home do portal" (era literalmente isso que estava acontecendo).

**Fix**: `authPage` agora é fechada depois de confirmar o login — abrindo
uma aba em branco (`about:blank`) ANTES de fechar, pra nunca zerar as
abas (janela do Chromium fecha inteira com zero abas). Uma aba em branco
é segura de deixar por aí: `ensureAuthenticatedPage` sempre navega ela
pra URL certa depois, sem risco de "achar que já está lá" por engano
(different de uma aba já em alguma URL real do ServiceNow, como a home
do portal).

Também adicionado um log (`URL do Inspection Report capturada: ...`)
logo depois de capturar a URL na Fase 0 — dá pra conferir diretamente no
log se a URL capturada é mesmo específica da turbina (com algum
identificador único) ou algo genérico, útil pra descartar de vez uma
segunda hipótese (SPA sem URL própria por registro) se esse bug persistir.

## Bug corrigido (diagnóstico do usuário): reaproveitamento de página pegava aba de vídeo de outra pá

Depois do fix de `authPage`, novo teste real mostrou um problema
diferente: na turbina 2, preenchendo a 1ª linha em modo Submissão
Automática, o campo "Blade serial number" foi selecionado como "A1 811
0618 0195" mas a leitura de confirmação voltou "T3 811 0475 0158" — um
valor de OUTRA pá.

**Causa raiz real, apontada pelo usuário**: não é sobre a mesma turbina
"lembrar" o valor da linha anterior — é sobre vídeos ficarem com a aba
aberta de propósito esperando revisão manual (design intencional, várias
pás/turbinas acumulam abas de vídeo abertas ao longo de uma sessão longa).
Em VÁRIOS pontos do código, "qual página reaproveitar" era decidido
buscando `context.pages().find(p => !p.isClosed())` — ou "a página mais
recente do contexto" — no CONTEXTO INTEIRO, sem nenhuma forma de
distinguir "uma página genuinamente livre" de "a aba de vídeo de outra
pá esperando o humano revisar". A automação podia acabar preenchendo o
formulário de uma pá EM CIMA da aba de vídeo de outra, misturando dados.

**Fix** — eliminado todo uso de "adivinhar no contexto compartilhado",
substituído por rastreamento explícito de página em cada caso:
- `authPage` (login) e `auditPage` (auditoria) — sempre abrem uma aba
  NOVA agora, nunca tentam reaproveitar nenhuma.
- Continuidade de aba entre linhas em modo Submissão Automática (design
  intencional, pra não abrir aba nova a cada defeito) — agora rastreada
  numa variável local (`sharedAutoSubmitPage`) escopada só a essa
  turbina/chamada, nunca mais buscando no contexto inteiro.
- `openDamageEntryForm` (detecção de popup ao clicar "Add Damage
  Entry") — antes pegava "a página mais recente do contexto inteiro"
  assumindo que era sempre o popup; agora conta as abas ANTES e DEPOIS
  do clique, e só trata como popup se o número de abas realmente
  cresceu POR CAUSA desse clique — senão usa a própria `targetPage`
  (que sabemos ser a certa).

Nenhuma dessas mudanças aponta pra uma aba de vídeo em momento nenhum —
cada fluxo só enxerga a própria página que ele mesmo abriu.

## Feature: Inspection End Date preenchido igual ao Start Date

Pedido do usuário: a inspeção é sempre feita num único dia — o campo
"Inspection End Date" do Inspection Report deve receber o MESMO valor
do "Inspection Start Date" (Data Coleta da planilha de controle), sem
precisar de coluna própria nem do checkbox "Inspection break" (que
continua desmarcado, como já era).

## Bug corrigido: Set Number errado no xlsx — Blade SN curto não é único entre turbinas

Usuário reportou (com dados de referência): na turbina VSR22-01-90659,
a pá 0527 (parte do trio 0526/0524/0527, todas Set 175) saiu no xlsx
gerado como "0527 0171" — Set errado.

**Causa raiz** — `blade_sets.json` (`resources/blade_sets.json`) tem
208 entradas, e o campo curto `bladeSn` (ex.: "527") **não é único
globalmente**, só dentro de cada turbina. Confirmado: o código "527"
aparece em DUAS entradas diferentes:
```
turbine: VSR06-01-90631 → serial "A1 811 0527 0171" → Set 0171
turbine: VSR22-01-90659 → serial "T3 811 0527 0175" → Set 175
```
`getBladeInfo(bladeSn)`/`getSetNumber(bladeSn)` (`src/main/services/
bladeSets.ts`) buscavam só pelo `bladeSn`, sem turbina — `.find()`
sempre retorna a PRIMEIRA ocorrência no array, e como a entrada da
VSR06-01 vem antes da VSR22-01 no JSON, toda pá "527" de QUALQUER
turbina caía errada no Set 0171 da VSR06-01. Usado em
`SnowMappings.getDamageDescription` e na geração de linhas "Video" do
xlsx de saída (`src/main/services/snowProcessor.ts`), ambos chamados
só com o `bladeSn` da planilha, sem a turbina.

**Fix** — `getBladeInfo`/`getSetNumber` agora aceitam um parâmetro
opcional `turbine`. Quando informado, o match é restrito primeiro às
pás dessa turbina (por `turbinePrefix` ou `turbine` completo); só cai
pro match global antigo (potencialmente ambíguo) se a turbina não tiver
nenhuma pá com esse `bladeSn` cadastrada. `snowProcessor.ts` agora
passa o `turbineSn` da própria linha da planilha (coluna H, já lido
pra outros campos) em toda chamada.

## Fix: checagem de upload de vídeo não trava mais a fila em modo Conferência Manual

Usuário apontou: "essa coisa de verificar o upload dos vídeos só faz
sentido se ele for submetido quando der certo, pra ele parar de enviar
os damages só pra esperar o vídeo não faz sentido" — e confirmou o
critério exato: "até pode continuar checando o upload mas tem que
submeter, se não for submeter não checa".

**Antes** — a Fase 3 (vídeo) sempre rodava a checagem `verifyVideoAttached`
(até `MAX_VIDEO_ROUNDS=3` rodadas, timeout de 180s por vídeo) dentro de
`runSnowDamageAutomation`, mesmo em modo Conferência Manual — onde o
vídeo NUNCA era submetido automaticamente (Submit sempre ficava com o
inspetor). Como a checagem não decidia nenhuma ação nesse modo, ela só
existia pra logar "confirmado" ou "não confirmado" — e como
`runFullAutomation` processa turbina por turbina de forma sequencial,
esperando cada `runSnowDamageAutomation` terminar antes de começar a
próxima, essa espera à toa atrasava a Inspection Report + Damage Entries
da turbina SEGUINTE sem nenhum ganho real.

**Fix** — a Fase 3 agora se divide em dois caminhos, pelo modo
(`autoSubmit`) da execução:
- **Conferência Manual** (`autoSubmit=false`): dispara o upload de cada
  vídeo (uma aba própria, uma atrás da outra) e já segue pro próximo,
  SEM chamar `verifyVideoAttached` e sem rodadas de retentativa — a aba
  fica aberta, o upload continua em segundo plano, e cabe ao inspetor
  conferir manualmente ao revisar. Isso elimina o atraso.
- **Submissão Automática** (`autoSubmit=true`): mantém a checagem e as
  retentativas (até `MAX_VIDEO_ROUNDS`), mas agora ela AUTORIZA uma
  ação de verdade — confirmado o upload, o robô chama o novo método
  `DamageEntryFiller.submitAndReadEntry()` (extraído do trecho de
  submissão que já existia em `fill()`) pra clicar Submit e gravar o
  número da entrada (`SNOW Entry #`) de volta na planilha, igual já
  acontecia com defeitos/blanks. Não confirmou -> não submete, aba fica
  aberta pra revisão manual, e a linha é reprocessada como antes.

## Reordenação: vídeo dispara ANTES dos defeitos, não depois

Teste real revelou dois problemas na v1.11.0: nenhuma aba de vídeo
visível pra acompanhar, e vídeos 3+ estourando o timeout de 180s um
atrás do outro. Investigando com o usuário: upload de vídeo é lento no
ServiceNow **por natureza** (processamento do lado do servidor), não
por disputa de banda entre abas cascateadas — então rodar várias abas
ao mesmo tempo não piora nem melhora o tempo de cada upload individual.

O que realmente importa é QUANDO esse tempo de espera é gasto. Um
defeito normal (vários campos em cascata: Sub Component, Failure Type,
Blade section, etc.) demora bem mais pra preencher, no relógio, do que
os poucos campos de um vídeo. Mas a Fase 3 (vídeo) só começava DEPOIS
que a Fase 1 (defeitos) inteira já tinha terminado — desperdiçando
exatamente o tempo em que o upload do vídeo podia estar rodando de
graça em segundo plano, sem ninguém checando nada, enquanto o robô
preenchia os defeitos numa aba totalmente separada.

**Fix** — inverteu a ordem: agora `runSnowDamageAutomation` dispara o
upload de TODOS os vídeos primeiro (preenche + anexa arquivo, sem
esperar terminar — extraído pra uma função `fillVideoTab` reaproveitada
tanto no disparo inicial quanto nas retentativas), guarda as abas
abertas, e só DEPOIS roda a Fase 1 (defeitos). A checagem/submissão de
vídeo (Fase 3) roda por último, sobre as abas já abertas — a essa
altura, depois de todo o tempo gasto preenchendo defeitos, a maioria
dos uploads já deve ter terminado sozinha, então a checagem tende a ser
quase instantânea em vez de estourar timeout. Reflexo direto: as abas
de vídeo já existem e vão terminando DURANTE a Fase 1, então dá pra
acompanhar e já ir revisando/enviando pro cliente enquanto os defeitos
ainda estão sendo preenchidos — não precisa esperar tudo terminar.

Efeito colateral bom: como cada vídeo já está aberto numa aba própria
desde o início, fica mais fácil achar/acompanhar visualmente (era um
dos sintomas relatados — "não tem nenhuma aba de vídeo pra acompanhar",
que na verdade era a aba só aparecendo tarde demais, no fim de tudo).

## Reorganização da UI do módulo (SnowAutomationModule.jsx)

Pedido do usuário: "muito texto pequeno que ninguém lê, botões
importantes que ficam no final, temos que reorganizar tudo pra ficar
mais simples de ver e apertar". O painel esquerdo tinha ~10 seções
empilhadas (banner, Automação Completa, planilha, fotos, pás, INC,
login, faixa de linhas, 6 checkboxes soltos, fila) com fonte majoritariamente
10-12px, e os botões de ação do fluxo manual (Adicionar à Fila / Rodar
Fila / Rodar Agora) só apareciam depois de rolar por tudo isso.

**Fix**:
- **"🚀 Automação Completa"** (o fluxo recomendado hoje, fruto de toda a
  reorganização Fase 0 + Módulo 24 desta sessão) virou o card de
  destaque sempre visível no topo, com fonte maior (15px de título,
  13px nos campos) e os botões "Rodar próxima pendente"/"Rodar todas as
  prontas" logo abaixo da configuração — sem precisar rolar nada.
- O fluxo antigo de **turbina manual / fila avulsa** (Planilha SNOW,
  Fotos, Pás, INC, Login, Faixa de linhas, Opções, Fila) foi movido pra
  dentro de um `<details>` colapsado por padrão ("⚙️ Turbina manual /
  fila avulsa (avançado)") — continua 100% funcional, só não compete
  mais por atenção com o fluxo principal.
- Os 6 checkboxes soltos (headless, autoSubmit, dryRun, Defeitos,
  Blanks, Vídeos) viraram uma caixa "Opções de execução" com separador
  visual entre os 3 modos de execução e as 3 categorias (essas em
  linha, 3 colunas, não mais empilhadas uma embaixo da outra).
- Fonte geral subiu de ~10-12px pra ~12.5-13px nos rótulos e inputs.

Verificado abrindo o instalador de verdade (não só o dev server) e
navegando visualmente pelo painel colapsado/expandido antes de
considerar concluído.

## Fix: Set Number derivado sempre do Serial, nunca mais da coluna separada

Usuário apontou (regra de negócio confirmada): o Set Number de uma pá é
SEMPRE os 4 últimos dígitos do Serial Number completo — formato
"A1/T3 811 XXXX YYYY", onde YYYY é o Set, literal, sem tirar nem
acrescentar zero à esquerda (Set 1000 é "1000", Set 999 é "0999").
`blade_sets.json` guarda o Set numa coluna SEPARADA (preenchida à mão
na planilha de origem), que na prática não é confiável.

**Achado ao investigar** `resources/blade_sets.json` (208 entradas):
- 89 entradas com Set em branco (`null`) na planilha de origem.
- 107 de 208 entradas (incluindo as 89 em branco) tinham o Set
  ARMAZENADO diferente do Set derivado do próprio serial — a maioria
  só faltando o zero à esquerda ("175" em vez de "0175"), mas achado
  um caso de transcrição errada de verdade: VSR07-06-90636 tinha Set
  "0173" guardado enquanto o serial ("A1 811 0551 0713") diz "0713".
- Esse bug afetava DOIS lugares: `SnowMappings.getDamageDescription`/a
  geração das linhas "Video" do xlsx do Módulo 23 (`snowProcessor.ts`,
  usa `getBladeInfo`/`getSetNumber`), E o campo "Blade Set Number" do
  próprio formulário Inspection Report (Fase 0, via
  `getBladesForTurbine` em `snowAutomation.ts:898`) — ou seja, o Set
  errado podia ir parar tanto na planilha quanto direto no ServiceNow.

**Fix** — dois níveis:
1. `resources/blade_sets.json` regenerado: Set de toda entrada
   recalculado a partir do próprio `serial` (script de correção
   pontual, não fica no app).
2. `bladeSets.ts`: `loadBladeSets()` agora SEMPRE deriva o Set a partir
   do `serial` de cada entrada ao carregar (nova
   `deriveSetNumberFromSerial`), sobrescrevendo o que estiver salvo na
   coluna separada — só cai pro valor antigo se o serial não bater no
   formato esperado (rede de segurança, não deveria acontecer já que
   os 208 batem 100%). Isso corrige o problema não só no
   `resources/blade_sets.json` já regenerado, mas também pra qualquer
   máquina de usuário que já tenha uma cópia antiga (e com o mesmo bug)
   seedada em `%APPDATA%/ArthwindSuite/blade_sets.json` — a derivação
   roda em cima de QUALQUER cópia, não depende de re-seedar o arquivo.

## Feature: Daily Activity Report gerado e anexado automaticamente + auditoria dupla

Pedido do usuário: toda tela de Inspection Report/Add Damage Entry no
ServiceNow mostra um bloco "Instructions(Mandatory)" pedindo pra baixar
um molde de logbook diário, preencher e subir de volta como anexo, com
o número do relatório no nome do arquivo — "senão não será
considerado". Além disso, pedido de uma segunda auditoria: conferir se
os campos do PRÓPRIO Inspection Report ficaram preenchidos certos antes
de partir pra auditoria dos defeitos.

**Estrutura do Daily Activity Report** (confirmada analisando um
exemplo real, `Daily Activity Report_IR0066855.xlsx`, aba `Activities`):
cabeçalho fixo nas linhas 1-4, 3 linhas de dados (uma por pá, sempre
linhas 5/6/7) com Date/Blade Serial/Team Supervisor/Technician
1/Activity/Details of Activity/Working Time preenchidos, e colunas
W/X/Y (# of Techs, Total hours, Techs x Hour) como FÓRMULAS que já
vêm no molde — não são preenchidas na mão. `Activity` sempre "Inspection
Internal" (valor real usado no exemplo), `Details of Activity` sempre
"Blade 1/2/3 Completed" (na mesma ordem Blade A/B/C já usada pro resto
do Inspection Report — pedido do usuário: "casar a linha de Pitch 1,
Pitch 2 e Pitch 3 com Blade A, Blade B e Blade C igual está no
formulário"), Working Time fixo em 1.5h (idem exemplo real).

**Número do relatório (IR######)**: é DIFERENTE do número do INC (ex:
tela mostra "INC3034409", mas o arquivo anexado se chama
"IR0066855..."). Achado importante do usuário: esse número já está
embutido no próprio texto do bloco de instruções — a frase "Example:
Daily Activity Report_IR0066857" não é um exemplo genérico, é o número
de VERDADE daquela turbina especificamente. `extractDailyReportIrNumber`
só procura esse texto na tela e extrai o que vem depois de "Daily
Activity Report" — não precisou de nenhum seletor de campo dedicado.

**Achado real ao implementar**: o exemplo original (`Daily Activity
Report_IR0066855.xlsx`) trava o ExcelJS pra sempre — `readFile` nunca
resolve nem rejeita, testado isolado e confirmado até no arquivo
original sem nenhuma edição (openpyxl consegue ler, mas avisa "Data
Validation extension is not supported", sinal de que o arquivo usa
alguma extensão XML de Excel mais nova que o ExcelJS não sabe processar
e trava tentando). Não dava pra usar esse arquivo (nem uma cópia
"limpa" dele) como molde. Solução: gerar um molde NOVO do zero
(openpyxl, só a aba "Activities" com cabeçalho E as fórmulas W/X/Y nas
linhas 5-7 — sem as abas ReadMe/dropdowns/Variables do original, que
são só ajuda visual pro humano, não afetam o ServiceNow aceitar o
anexo) — confirmado que o ExcelJS lê e escreve esse molde novo sem
travar.

**Fix/Feature**:
- `resources/daily_activity_report_template.xlsx` — molde em branco
  empacotado no instalador, gerado do zero (não é uma cópia do exemplo
  real — ver achado acima), com a aba "Activities", cabeçalho e as
  fórmulas W/X/Y já nas linhas 5-7. Não depende de baixar nada do
  ServiceNow a cada turbina.
- `generateDailyActivityReport(...)` (`snowAutomation.ts`) — preenche o
  molde via ExcelJS com os dados da turbina + `DAILY_REPORT_LEADER`
  fixo ("Allan Thiago", único valor válido hoje porque só tem o parque
  Lagoa dos Ventos cadastrado — vira configurável por windfarm se
  entrar um parque novo) + técnico ALTERNADO entre "Raimundo Nonato" e
  "Gabriel Lima" a cada turbina (pedido do usuário: não é informação
  relevante, só precisa estar preenchida).
- `InspectionReportFiller.uploadAttachment(filePath, label)` — reaproveita
  o mesmo botão "Add attachments" e a mesma rede de segurança contra
  abrir aba nova sem querer já usada pras fotos/vídeos de defeito.
- `InspectionReportFiller.verifyFilled(data)` — segunda auditoria: lê de
  volta (não confia que "preencheu" = "salvou") Responsible technicians,
  Inspection Start/End Date, Access method, Blade type, Purchase Order,
  Blade A/B/C serial number e Blade set number, comparando com o que
  devia estar lá. Roda tanto pra Inspection Report recém-criado quanto
  pra um que já existia (`state === 'show'`) — SEMPRE lê a tela, nunca
  assume. Só reporta divergências (não trava a turbina), porque um
  report 'show' antigo pode legitimamente ter outro técnico/data.
- `ServiceNowFormFiller.readTextValue(label)` — contraparte de leitura
  do `fillText`, usada pela auditoria acima.
- Wiring em `runFullAutomation`: depois de garantir o Inspection Report
  (criado ou já existente), roda `verifyFilled` → extrai o número IR →
  gera o Daily Activity Report → sobe como anexo — tudo ANTES de fechar
  a aba e chamar o Módulo 24 (defeitos).

## Duas pás faltando em blade_sets.json, achadas pelo usuário em teste real

Usuário reportou pelo dropdown "Blade serial number" do ServiceNow (na
turbina VSR22-07-90665, só apareciam 2 seriais completos + um "588"
truncado) que uma pá parecia faltar na nossa base. Rodei uma varredura
completa nas 70 turbinas de `blade_sets.json` procurando qualquer uma
sem as 3 "Rotor blade 1/2/3" — achei mais uma além dessa:

- **VSR22-07-90665** — faltava Rotor blade 2 (só tinha 1 e 3).
- **VSR07-03-90640** — faltava Rotor blade 1 (só tinha 2 e 3).

(O "588" truncado no dropdown do ServiceNow é um problema separado, do
lado de lá — esse combobox é preenchido pelo cadastro da turbina no
próprio ServiceNow, não pelo nosso `blade_sets.json`.)

Nenhuma outra turbina tinha esse problema (verificado: sem bladeSn/
serial duplicado dentro da mesma turbina, sem campo vazio, sem
`component` fora do padrão). Usuário forneceu os seriais reais:
- VSR22-07-90665 Rotor blade 2: `A1 811 0624 0199`
- VSR07-03-90640 Rotor blade 1: `T3 811 0492 0164`

Ambos batem com o Set das pás irmãs da mesma turbina (0199 e 0164
respectivamente) — adicionados em `blade_sets.json`, agrupados junto
das outras pás da mesma turbina. Base agora com 210 pás em 70 turbinas,
todas com as 3 pás completas.

## UI: Submissão Automática movida pro centro + zero texto explicativo

Pedido do usuário: "no caso de ui era interessante subir esse botão pra
uma região mais central, hoje fica no final do modo de uma turbina, até
porque já está bem robusto e não precisa ser algo escondido" — o
checkbox "Submeter formulário automaticamente" estava dentro da caixa
"Opções de execução", por sua vez dentro do `<details>` colapsado
"Turbina manual (avançado)" — ou seja, pra ligar Submissão Automática
(que também controla o fluxo principal "Automação Completa", não só o
manual) era preciso abrir a seção avançada primeiro.

**Fix**: `autoSubmit` virou um checkbox isolado, sempre visível, entre
o card "Automação Completa" e a seção colapsada — com borda destacada
quando ligado. Removida a cópia duplicada de dentro de "Opções de
execução" (mesmo estado, um controle só).

Pedido relacionado, mais amplo: "podemos nunca mais colocar qualquer
texto explicativo em qualquer módulo que seja" — removidos os 3 blocos
de texto explicativo que ainda restavam no módulo (descrição da
"Automação Completa", legenda da pasta de fotos, legenda da faixa de
linhas). Regra gravada em memória pra valer daqui pra frente em
qualquer módulo, não só nesse.

## Removida a tentativa (sempre inútil) de ler o número DAM da tela

Usuário confirmou: o número da entrada recém-criada (ex.: "DAM1115650")
NUNCA fica acessível durante a submissão — só aparece depois, numa
planilha de auditoria à parte do ServiceNow, não na tela ao vivo. A
automação vinha tentando ler isso mesmo assim
(`readSubmittedEntryNumber`, com até 5s de espera por submissão) pra
gravar na coluna "SNOW Entry #" da planilha (`writeBackEntryNumber`) e
usar isso como sinal de "já submetido" numa próxima rodada
(`readDamageRows`). Como o valor nunca vinha, essa tentativa SEMPRE
falhava silenciosamente — só desperdiçava ~5s por linha em modo
Submissão Automática (defeitos e vídeos) e nunca preenchia a coluna de
verdade.

**Fix**: removida a tentativa de leitura inteira —
`readSubmittedEntryNumber`, `writeBackEntryNumber` e a checagem da
coluna "SNOW Entry #" em `readDamageRows` foram excluídos.
`submitAndReadEntry` agora só clica Submit e loga sucesso, sem tentar
ler nada de volta. Isso NÃO enfraquece a detecção de "já submetido" —
essa detecção sempre foi garantida de verdade pela auditoria ao vivo da
tabela do ServiceNow (`checkRowExistsInLiveTable`/
`auditLiveDamageEntries`, que casa pá+DF+seção direto na tabela),
independente desse número.

## Pendência: auditoria do Inspection Report / Daily Activity Report não apareceu no log

Usuário reportou não ver nada no log sobre a segunda auditoria
(`verifyFilled`) nem sobre o upload do Daily Activity Report num teste
recente. Conferido o código: está corretamente incondicional (roda
tanto pra Inspection Report recém-criado quanto já existente, antes de
fechar a aba), então não é um bug óbvio de lógica. Hipótese mais
provável: esse teste rodou pelo fluxo "Turbina manual / Rodar Agora"
(que chama o Módulo 24 direto, sem passar pela Fase 0) em vez de
"Automação Completa" — só esse último passa por esse trecho de código.
Perguntado ao usuário qual fluxo foi usado; aguardando confirmação
antes de investigar mais fundo.

**Atualização**: usuário confirmou que usou "Automação Completa" +
Submissão Automática. Log real da rodada mostrou:
`✓ Auditoria do Inspection Report: todos os campos conferidos batem.`
seguido de `⚠ Não abriu o seletor de arquivo pra anexar Daily Activity
Report.` — ou seja, `verifyFilled` estava funcionando desde o início
(só não tinha sido notado no log anterior); o bug de verdade era só no
upload do anexo.

## Fix: upload do Daily Activity Report — modal de 2 cliques, não 1

Print do usuário da tela do Inspection Report já existente confirmou:
diferente do formulário de Damage Entry (onde o botão "Add attachments"
abre o seletor nativo de arquivo direto no clique), o ícone de anexo
(📎) do CABEÇALHO de um registro já salvo abre primeiro um MODAL "Add
attachments" com um link "Choose a file" DENTRO — só esse segundo
clique dispara o seletor de arquivo de verdade. `uploadAttachment`
tentava só o primeiro clique, esperava o evento `filechooser` 5s, e
desistia.

**Fix**: `uploadAttachment` agora cobre os dois fluxos — tenta o
seletor direto no primeiro clique (mantém compatível com o padrão do
Damage Entry, se algum dia for reaproveitado lá); se não abrir, confere
se apareceu o modal com "Choose a file" e clica nele, só então espera o
`filechooser` de novo. Fecha o modal pelo botão "Close" no final, se
ainda estiver aberto.

## Fix: login não detectava a tela de autenticação de dois fatores (2FA)

Usuário reportou: "ele detectou o login ao colocar e-mail e senha mas
tem a autenticação de dois fatores... ele considerou o login, fechou a
aba de 2FA e já tentou procurar o formulário" — travando o resto da
automação, porque a sessão na verdade ainda não estava autenticada de
verdade.

**Causa raiz**: `isLoginPage()` só reconhecia a tela de usuário/senha
(campo de senha visível + texto "sign in"/"entrar") ou URLs de
login/SSO/OAuth conhecidas. Assim que o campo de senha some da tela
(indo pra tela de 2FA), `isLoginPage()` já retornava `false` — o robô
achava que o login tinha terminado, fechava a aba de checagem (padrão
já usado pra não deixar ela contaminando o resto da sessão), e partia
pra procurar o formulário com uma sessão que ainda esperava o segundo
fator.

**Fix**: `isLoginPage()` agora também reconhece telas de 2FA/MFA — por
URL (login.microsoftonline.com, okta.com, processauth, /kmsi — padrões
comuns de provedores de SSO corporativo) e por texto visível na tela
("two-factor", "verify your identity", "approve sign in", "enter the
code", "autenticação de dois fatores", "digite o código", etc, em
inglês e português). `ensureAuthenticatedPage` já tinha o loop de
espera certo (até 5 minutos, dando tempo de alguém aprovar/digitar o
código) — só precisava saber reconhecer que ainda estava numa etapa de
login, não fechar a aba cedo demais.

## Ainda investigando: upload do Daily Activity Report continua falhando (v1.19.0)

O fix da v1.17.1 (clicar "Choose a file" dentro do modal) NÃO resolveu
— usuário confirmou rodando exatamente v1.19.0 e o log mostra a mesma
falha (`⚠ Não abriu o seletor de arquivo pra anexar Daily Activity
Report.`). Mais que isso: usuário esclareceu que o clique **não faz
NADA visível** — nem o modal "Add attachments" chega a abrir. Isso
descarta a hipótese de "modal de 2 cliques" — o problema é mais básico:
o seletor (`'.attachment-button, [title*="attachment" i]'` OR texto
"Add attachments" OR link/botão com esse texto) provavelmente está
CLICANDO NO ELEMENTO ERRADO — algo que "parece visível" pro Playwright
mas não é o ícone de anexo de verdade (ex.: a palavra "Add attachments"
só aparece como TOOLTIP ao passar o mouse sobre o clipe 📎, não como
texto estático na página — pode nunca ter batido com nenhuma das 3
alternativas do seletor, e o que `isVisible()` achou pode ser outro
elemento qualquer da página com "attachment" em algum atributo, sem
relação nenhuma com o registro atual).

**Decisão**: em vez de tentar mais um seletor no escuro, adicionado
diagnóstico automático (`dumpAttachmentDebugInfo`) que roda toda vez
que o upload falha — salva um screenshot da tela inteira em
`%TEMP%/arthwind-attachment-debug/` E lista todo elemento da página com
"attach" no `title`/`aria-label`/`class` (até 10, com tag, visibilidade
e os 3 atributos). Da próxima falha, isso deve mostrar o elemento real
que precisa ser usado, em vez de mais uma tentativa às cegas.

## Fix de verdade: seletor de "Add attachments" pegava o elemento errado

O diagnóstico funcionou de primeira. Log real mostrou 8 elementos com
"attach" na tela — dois deles batiam com o seletor antigo:
- `<div class="pull-right attachment-button ng-scope" title="Add an
  attachment">` (singular) — só o ícone do cabeçalho, clicar nele não
  abre nada de útil.
- `<button class="panel-button sp-attachment-add btn btn-link"
  title="Add attachments" aria-label="Add attachments">` (plural,
  mesmo texto da instrução obrigatória da tela) — o botão de verdade,
  dentro do painel de anexos que já vem expandido na tela (não é um
  modal separado).

O seletor antigo unia os dois com `.or()` e usava `.first()` — que
pega o primeiro em ORDEM DE DOM entre todos os candidatos combinados,
não o primeiro item da lista de alternativas escrita no código. Como o
`<div>` do cabeçalho vem antes no DOM, ele sempre ganhava — batendo
exatamente com o relatado: "não faz nada, nem o modal abre".

**Fix**: `uploadAttachment` agora tenta o botão específico e confirmado
(`button.sp-attachment-add` ou `button[aria-label="Add attachments"
i]`) PRIMEIRO, sozinho — só cai no seletor largo antigo (que pode
pegar o elemento errado) se esse específico não existir na tela.

## Fix de verdade #2: molde reconstruído dava erro no ServiceNow — precisa ser bit-a-bit o original

Usuário testou o molde reconstruído do zero (v1.15.0, pra contornar o
ExcelJS travando) e confirmou: "essa mudança no layout do daily não
funcionou, tem que ser exatamente o template deles... os que eu subi
dão erro na hora de finalizar." Ou seja, o ServiceNow (ou alguma
validação ligada à conclusão do Inspection Report) rejeita um arquivo
que não seja estruturalmente idêntico ao molde oficial — mesmo tendo a
mesma aba "Activities" com as mesmas colunas.

**Fix de verdade**: em vez de reconstruir o molde, `resources/
daily_activity_report_template.xlsx` agora é uma CÓPIA BIT-A-BIT do
molde oficial fornecido pelo usuário (baixado direto do link do
ServiceNow, em branco, sem nenhuma edição). E como o ExcelJS trava pra
sempre tentando ler esse arquivo (confirmado isolado, até no arquivo
original sem edição nenhuma — provável extensão XML de Excel mais nova
que o ExcelJS não processa), `generateDailyActivityReport` agora edita
o XML bruto de dentro do `.xlsx` (que é só um `.zip`) via `JSZip`
(dependência que já existia no projeto, usada em `horizon.ts`) — sem
nunca passar pelo parser do ExcelJS:
- `findActivitiesSheetPath` acha dinamicamente qual `sheetN.xml` é a
  aba "Activities" (via `workbook.xml` + `workbook.xml.rels`), em vez
  de assumir `sheet1.xml` — sobrevive a um molde reorganizado no
  futuro.
- Nas linhas 5-7 do molde em branco, a célula `L` (Working Time) já
  existe vazia (`<c r="L5" s="2"/>`) — única âncora confiável, já que
  as colunas A-K não têm NENHUMA célula ainda numa linha em branco de
  verdade. O código insere as novas células (A, B, D, E, J, K, como
  texto inline `t="inlineStr"`) bem antes dessa âncora, na ordem certa
  de coluna, e só então dá valor pra própria célula L.
- Se a âncora não bater (molde mudou de estrutura), lança um erro claro
  em vez de gerar um arquivo quebrado silenciosamente.
- Resto do arquivo (fórmulas W/X/Y, estilos, abas ReadMe/dropdowns/
  Variables, tabelas do Excel) fica 100% intacto — só as 3 linhas de
  dados são tocadas.
- `compression: 'DEFLATE'` no `zip.generateAsync` — sem isso o JSZip
  usa STORE (sem compressão) por padrão e o arquivo sai ~4x maior à
  toa.

Testado isolado (fora do app) contra o molde de verdade: gera o
arquivo, abre certinho no openpyxl com as 4 abas intactas e os valores
das 3 linhas corretos.

## Feature: não sobe o Daily Activity Report de novo se já estava anexado

Usuário pediu: "é importante verificar se o Daily já subiu porque toda
vez que eu rodo o programa ele sobe o daily novamente" — rodando a
automação de novo pra uma turbina cujo Inspection Report já existia
(`state === 'show'`), o anexo subia de novo, gerando duplicata.

**Fix**: novo método `InspectionReportFiller.hasDailyActivityReportAttached()`
confere a lista de anexos já existente na tela (mesmo texto de rótulo
achado no diagnóstico real, "Daily Activity Report") ANTES de gerar ou
subir qualquer coisa — se já estiver lá, só loga e pula.

## Fix de verdade #3: células novas saíam travadas (sem estilo = sem desbloqueio)

Usuário mandou um exemplo gerado (v1.20.0) e reportou: "não parecem
texto, as células sumiram e fica um texto que não pode ser editado".

**Causa raiz confirmada** (não foi chute — verificado no XML de
estilos do molde): a aba "Activities" tem PROTEÇÃO DE FOLHA ativa
(`ws.protection.sheet == True`). As colunas de entrada de dado de
verdade (A, B, D, E, J, K, L) têm estilos com `<protection
locked="0"/>` explícito — são as ÚNICAS células que ficam editáveis
com a proteção ligada. As novas células que a automação inseria não
tinham NENHUM atributo `s=` (estilo), o que no XML significa estilo
índice 0 — que NÃO tem esse desbloqueio. Com a proteção ativa, essa
célula sem desbloqueio explícito fica travada — exatamente "texto que
não pode ser editado".

**Fix**: cada célula inserida agora leva o índice de estilo PADRÃO da
própria coluna (lido de `<cols>` no XML do molde: A=24, B=2, D/E/J/K=
26 — os mesmos que uma célula digitada à mão nessa coluna receberia).
Confirmado com openpyxl depois do fix: `ws.protection.sheet == True`
e todas as 7 células novas (`A5,B5,D5,E5,J5,K5,L5`) com
`cell.protection.locked == False` — igual às células de entrada de
verdade.

## Feature: coluna "Blade Position (Pitch #)" preenchida (Pitch 1/2/3 = Blade A/B/C)

Usuário confirmou o layout (célula desbloqueada, editável) e pediu a
última coluna que faltava: "Blade Position", igual ao pedido original
— "casar a linha de Pitch 1, Pitch 2 e Pitch 3 com Blade A, Blade B e
Blade C igual está no formulário". Coluna C agora recebe "Pitch 1"/
"Pitch 2"/"Pitch 3" na mesma ordem das linhas (Blade A/B/C), com o
estilo padrão da coluna (índice 2, mesmo de B) pra continuar
desbloqueada. Confirmado com openpyxl no exemplo gerado.
