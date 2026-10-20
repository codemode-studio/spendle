/**
 * Messages for the API failures the app can act on. The API answers every
 * failure with `{ _tag, reason, detail }`; `reason` is stable, so the UI keys
 * its copy on it and falls back to the class of failure.
 */
const reasonMessages: Record<string, string | undefined> = {
  invalid_payload: 'Confira os campos e tente de novo.',
  invalid_query: 'Filtro inválido. Limpe os filtros e tente de novo.',
  invalid_cursor: 'A página mudou. Volte para a primeira página.',
  card_terms_required: 'Informe os dias de fechamento e vencimento do cartão.',
  invalid_token: 'O app não tem acesso à API. Confira SPENDLE_API_TOKEN.',
  member_required: 'O app não informou quem entrou. Entre novamente.',
  not_owner: 'Só quem criou o espaço adiciona ou remove pessoas.',
  already_member: 'Essa pessoa já faz parte do espaço.',
  member_elsewhere:
    'Essa conta já registrou algo no próprio espaço, por isso não pode entrar neste automaticamente.',
  member_not_found: 'Essa pessoa não faz parte do espaço. Recarregue a página.',
  owner_stays: 'Quem criou o espaço não pode ser removido.',
  qa_fixed_members: 'Na QA, as pessoas do espaço não mudam.',
  not_allowed:
    'Esse e-mail não pode entrar no Spendle. Inclua-o em SPENDLE_ALLOWED_EMAILS e tente de novo.',
  unclaimed_database:
    'Os dados de antes dos espaços ainda não têm dono. Rode `vp run --filter @spendle/server claim-space --email <seu e-mail>`.',
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
  incompatible_account:
    'Essa conta não combina com a do banco: tipo, moeda ou titular diferentes.',
  item_already_registered: 'Essa conexão já foi registrada.',
  item_belongs_elsewhere: 'Essa conexão pertence a outro pedido de conexão.',
  not_linked: 'Essa conta do banco não está vinculada.',
  provider_account_not_found:
    'Conta do banco não encontrada. Atualize a conexão.',
  owner_not_found: 'Titular não encontrado. Recarregue a página.',
  card_terms_forbidden: 'Só cartões de crédito têm fechamento e vencimento.',
  investment_purpose: 'Contas de corretora usam a finalidade investimento.',
  currency_mismatch: 'A moeda do arquivo não é a da conta.',
  mixed_currencies: 'O arquivo mistura moedas. Exporte uma conta por vez.',
  imported_to_other_account: 'Esse arquivo já foi importado em outra conta.',
  summary_balance_mismatch:
    'O resumo do arquivo não fecha com as movimentações. Exporte o extrato de novo.',
  malformed_ofx: 'O OFX está corrompido. Exporte o arquivo de novo.',
  malformed_csv: 'O CSV não está no formato esperado.',
  unsupported_format: 'Formato não suportado. Use OFX, CSV ou PDF.',
  unsupported_encoding: 'Codificação do arquivo não suportada.',
  account_mismatch: 'O arquivo é de outra conta.',
  multiple_statements: 'O arquivo tem mais de um extrato. Envie um por vez.',
  no_statement: 'Nenhum extrato encontrado no arquivo.',
  relation_not_found: 'Vínculo não encontrado. Recarregue a página.',
  decision_not_found: 'Decisão não encontrada. Recarregue a página.',
  pattern_not_found: 'Padrão não encontrado. Recarregue a página.',
  pattern_taken: 'Já existe um padrão igual para essa direção.',
  invalid_pattern: 'Padrão inválido: use ao menos 3 caracteres.',
  no_prefix_candidate: 'Esse padrão não tem um prefixo de agregador.',
  protected_category: 'Categoria protegida: não pode ser alterada.',
  system_category: 'Categoria de sistema: não pode ser alterada.',
  invalid_parent: 'Categoria mãe inválida.',
  blank_name: 'Informe um nome.',
  nothing_to_confirm: 'Não há sugestão para confirmar.',
  exceeds_purchase: 'O estorno é maior que a compra.',
  not_a_card: 'Essa conta não é um cartão de crédito.',
  pluggy_unavailable: 'A Pluggy não respondeu. Tente de novo em instantes.',
  pluggy_unauthorized: 'As credenciais da Pluggy foram recusadas.',
  pluggy_not_configured:
    'Open Finance desligado: configure PLUGGY_CLIENT_ID e PLUGGY_CLIENT_SECRET no servidor.',
  database_unavailable: 'O banco de dados está indisponível. Tente de novo.',
  month_closed:
    'O mês já está fechado: o plano dele não muda. Ajuste o plano no próximo mês.',
  closing_blocked: 'Resolva as pendências do mês antes de fechá-lo.',
  invalid_allocation: 'Os percentuais precisam somar 100%.',
  strategy_not_found: 'Estratégia não encontrada. Recarregue a página.',
  goal_not_found: 'Meta não encontrada. Recarregue a página.',
  recurrence_not_found: 'Recorrência não encontrada. Recarregue a página.',
  occurrence_not_found: 'Ocorrência não encontrada. Recarregue a página.',
  match_not_found: 'Essa correspondência mudou. Recarregue a página.',
  occurrence_resolved: 'Essa ocorrência já foi resolvida.',
  recurrence_paused: 'Retome a recorrência antes de vincular pagamentos.',
  entry_not_linkable:
    'Esse lançamento não pode ser vinculado: confira se está confirmado, na mesma moeda e direção, e se não é transferência.',
  entry_outside_period:
    'Esse lançamento é de outro período. Vincule-o ao período da data dele.',
  single_payment:
    'Essa recorrência aceita um pagamento por período. Para somar vários, use envelope.',
  nothing_linked: 'Vincule pelo menos um lançamento antes de concluir.',
  has_confirmed_links:
    'Desvincule os pagamentos confirmados antes de excluir a recorrência.',
  destination_required: 'Escolha a conta ou o cartão do destino fixo.',
  assistant_not_configured:
    'Assistente desligado: configure OPENROUTER_API_KEY e OPENROUTER_MODEL no servidor.',
  assistant_unavailable: 'O assistente não respondeu. Tente de novo.',
  invalid_report: 'A análise não fechou com os gastos. Tente de novo.',
  file_too_large: 'O arquivo passa de 1,5 MB, o limite por extrato.',
  api_unreachable:
    'O servidor da API não respondeu. Inicie `vp run --filter @spendle/server dev` e tente de novo.',
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
