/**
 * Messages for the V2 API failures the app can act on. The API answers every
 * failure with `{ _tag, reason, detail }`; `reason` is stable, so the UI keys
 * its copy on it and falls back to the class of failure.
 */
const reasonMessages: Record<string, string | undefined> = {
  invalid_payload: 'Confira os campos e tente de novo.',
  invalid_query: 'Filtro inválido. Limpe os filtros e tente de novo.',
  invalid_cursor: 'A página mudou. Volte para a primeira página.',
  card_terms_required: 'Informe os dias de fechamento e vencimento do cartão.',
  invalid_token: 'O app não tem acesso à API. Confira SPENDLE_API_TOKEN.',
  account_not_found: 'Conta não encontrada. Recarregue a página.',
  entry_not_found: 'Lançamento não encontrado. Recarregue a página.',
  connection_not_found: 'Conexão não encontrada. Recarregue a página.',
  category_not_found: 'Categoria não encontrada. Recarregue a página.',
  already_linked: 'Essa conta do banco já está vinculada a outra conta.',
  connection_disconnected: 'A conexão foi desfeita. Conecte o banco de novo.',
  linked_to_provider:
    'Conta alimentada pelo Open Finance: desvincule antes de mudar isso.',
  running_balance_mismatch:
    'O saldo do arquivo não fecha com as movimentações. Exporte o extrato de novo.',
  not_a_pair: 'Esses dois lançamentos não formam um par válido.',
  category_not_assignable:
    'Categoria de sistema: transferências e faturas são definidas pela conciliação.',
  pluggy_unavailable: 'A Pluggy não respondeu. Tente de novo em instantes.',
  pluggy_unauthorized: 'As credenciais da Pluggy foram recusadas.',
  pluggy_not_configured:
    'Open Finance desligado: configure PLUGGY_CLIENT_ID e PLUGGY_CLIENT_SECRET no servidor.',
  database_unavailable: 'O banco de dados está indisponível. Tente de novo.',
  v2_unreachable:
    'O servidor da API não respondeu. Inicie `pnpm --filter @spendle/server dev` e tente de novo.',
}

const tagMessages: Record<string, string | undefined> = {
  InvalidRequest: 'Pedido inválido. Confira os campos.',
  Unauthorized: 'Sem acesso à API.',
  NotFound: 'Registro não encontrado. Recarregue a página.',
  Conflict: 'O estado mudou. Recarregue a página e tente de novo.',
  Rejected: 'A operação foi recusada.',
  InternalError: 'Erro no servidor. Tente de novo.',
  ProviderFailed: 'A Pluggy falhou. Tente de novo em instantes.',
  Unavailable: 'Recurso indisponível neste servidor.',
}

export function apiFailureMessage(failure: {
  tag: string
  reason: string
  detail: string | null
}) {
  return (
    reasonMessages[failure.reason] ??
    tagMessages[failure.tag] ??
    'Não foi possível concluir. Tente de novo.'
  )
}

/** The message a mutation error should show, whatever was thrown. */
export function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}
