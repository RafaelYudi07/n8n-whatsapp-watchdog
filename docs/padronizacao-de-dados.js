// Cópia legível do nó "Padronização de dados" (fonte: watchdog-instancias-whatsapp.json)
// Para alterar, edite o nó no n8n e exporte o workflow de novo.

// ===== Memória estática entre execuções =====
const staticData = $getWorkflowStaticData('global');
staticData.lastStates     = staticData.lastStates     || {};
staticData.downSince      = staticData.downSince      || {};
staticData.clientNotified = staticData.clientNotified || {};
staticData.pendingDown    = staticData.pendingDown    || {};   // 1ª rodada offline, aguardando confirmação
staticData.apiFora        = staticData.apiFora        || false;

// ===== CONFIG por conexão: vem do nó "conexões" =====
const cfgList = ($('conexões').first().json.conexoes) || [];
const CLIENTES = {};
for (const c of cfgList) { CLIENTES[c.conexao_nome] = c; }

const MINUTOS_LIMITE = 30;                   // produção = 30 (use 0 só p/ TESTE)
const LIMITE_MS      = MINUTOS_LIMITE * 60 * 1000;
const RODADAS_CONFIRMA = 2;                  // queda só vale após N rodadas seguidas offline (1 = imediato)
const REPETIR        = false;
const MASCOTE        = '';

// ===== TESTE: força offline. Use o nome LIMPO (sem prefixo). Deixe [] em produção. =====
const TESTE_OFFLINE  = [];

const placeholder = (w) => !w || w.indexOf('exemplo.bitrix24') !== -1;

// remove o prefixo "Nome da Conexão = " que o nó anterior adiciona
const limpaNome = (s) => (s || '').toString().replace(/^Nome da Conex[aã]o\s*=\s*/i, '').trim();

// horário local (UTC-4) no formato DD/MM HH:MM
const fmtLocal = (ms) => {
  if (!ms) return '';
  const d = new Date(ms - 4 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getUTCDate()) + '/' + p(d.getUTCMonth() + 1) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
};

// erro de comunicação com a API (não diz nada sobre o WhatsApp): timeout, conexão caída, 5xx, 429
const CODIGOS_REDE = ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ESOCKETTIMEDOUT'];
const statusHttp = (e) => Number(e.status || e.httpCode || e.statusCode || (String(e.message || '').match(/^(\d{3})\b/) || [])[1] || 0);
const erroDeRede = (e) => {
  if (!e) return false;
  const st = statusHttp(e);
  if (CODIGOS_REDE.includes(e.code)) return true;
  if (st >= 500 || st === 429) return true;
  return !st;   // sem status HTTP = não chegou resposta da API
};

const agora = Date.now();
const itens = $input.all().map(i => i.json);

const novasDesconectadas    = [];
const recuperadas           = [];
const clientesParaNotificar = [];
const semResposta           = [];

const getNome  = (i) => limpaNome(i.raw?.nomeConexao || i.nomeConexao || i.conexao_nome || '');
const getState = (i) => (i.state || '').toString().trim().toUpperCase();

const validos = itens.filter(i => getNome(i));
const todasSemResposta = validos.length > 0 && validos.every(i => erroDeRede(i.error));

// ===== API inteira fora: não mexe em nenhum estado, só avisa o grupo 1x =====
let apiCaiu = false, apiVoltou = false;
if (todasSemResposta) {
  if (!staticData.apiFora) { apiCaiu = true; staticData.apiFora = agora; }
  return [{ json: {
    alertar: apiCaiu, apiCaiu, apiVoltou: false, apiForaDesde: fmtLocal(staticData.apiFora),
    novasDesconectadas, recuperadas, clientesParaNotificar, semResposta,
    temClientesParaNotificar: false, qtdNovasQuedas: 0,
    totalOffline: Object.values(staticData.lastStates).filter(v => v === false).length
  } }];
}
const apiForaDesde = staticData.apiFora ? fmtLocal(staticData.apiFora) : '';
if (staticData.apiFora) { apiVoltou = true; staticData.apiFora = false; }

for (const inst of itens) {
  const nome = getNome(inst);
  if (!nome) continue;

  // falha de comunicação só desta conexão: mantém o último estado conhecido
  if (!TESTE_OFFLINE.includes(nome) && erroDeRede(inst.error)) {
    semResposta.push({ nome, erro: inst.error.code || inst.error.message || 'sem resposta' });
    continue;
  }

  const state = inst.error
    ? 'ERRO ' + (statusHttp(inst.error) || '') + ' ' + (String(inst.error.message || '').match(/error_text\\?":\\?"([^"\\]+)/) || [, ''])[1]
    : getState(inst);
  const estaConectada = TESTE_OFFLINE.includes(nome) ? false : (state === 'CONNECTED' && !inst.error);
  const anteriorEraOk = staticData.lastStates[nome] !== false;

  if (!estaConectada) {
    if (anteriorEraOk) {
      // confirma a queda só depois de RODADAS_CONFIRMA rodadas seguidas offline
      const pend = staticData.pendingDown[nome] || { since: agora, rodadas: 0 };
      pend.rodadas += 1;
      staticData.pendingDown[nome] = pend;
      if (pend.rodadas < RODADAS_CONFIRMA) continue;

      delete staticData.pendingDown[nome];
      novasDesconectadas.push({ nome, state: state.trim() || 'SEM_STATE', desde: fmtLocal(pend.since) });
      staticData.downSince[nome]      = pend.since;
      staticData.clientNotified[nome] = false;
    }
    staticData.lastStates[nome] = false;

    const desde        = staticData.downSince[nome] || agora;
    const tempoOffline = agora - desde;
    const jaAvisou     = staticData.clientNotified[nome] === true;

    if (tempoOffline >= LIMITE_MS && (REPETIR || !jaAvisou)) {
      const cli = CLIENTES[nome] || {};
      const semConfig = placeholder(cli.webhook) || !cli.dialogId;
      clientesParaNotificar.push({
        nome,
        minutosOffline: Math.round(tempoOffline / 60000),
        webhook:  cli.webhook  || null,
        dialogId: cli.dialogId || null,
        mensagem: cli.mensagem || '',
        imagem:   MASCOTE || '',
        qr_link:  cli.qr_link  || '',
        semConfig
      });
      staticData.clientNotified[nome] = true;
    }
  } else {
    delete staticData.pendingDown[nome];
    if (!anteriorEraOk) {
      recuperadas.push({ nome, state: 'CONNECTED', desde: fmtLocal(staticData.downSince[nome]) });
    }
    staticData.lastStates[nome] = true;
    delete staticData.downSince[nome];
    staticData.clientNotified[nome] = false;
  }
}

return [
  {
    json: {
      alertar: apiVoltou || novasDesconectadas.length > 0 || recuperadas.length > 0 || clientesParaNotificar.length > 0,
      apiCaiu,
      apiVoltou,
      apiForaDesde,
      novasDesconectadas,
      recuperadas,
      clientesParaNotificar,
      semResposta,
      temClientesParaNotificar: clientesParaNotificar.length > 0,
      qtdNovasQuedas: novasDesconectadas.length,
      totalOffline: Object.values(staticData.lastStates).filter(v => v === false).length
    }
  }
];
