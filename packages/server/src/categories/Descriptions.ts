/**
 * What each built-in category covers, sent to the model beside its name.
 * Without a description the model sees only the name, and its confident
 * answers were right less often in the evaluation (`evals/categories`).
 * Categories the person creates go by their name alone.
 */
export const categoryDescriptions: Readonly<Record<string, string>> = {
  business:
    'Despesas da empresa da família: fornecedores, registro de domínio, franquia, serviços para o negócio.',
  education: 'Escola, mensalidades, cursos e material escolar.',
  family: 'Despesas com filhos e repasses a familiares.',
  financing: 'Parcelas de financiamento de imóvel ou veículo e empréstimos.',
  groceries:
    'Compras de supermercado, atacado, hortifruti e padaria para abastecer a casa.',
  health: 'Plano de saúde, consultas, exames, terapias, dentista e farmácia.',
  housing:
    'Aluguel, condomínio, administradora do imóvel, gás e água da residência.',
  insurance: 'Seguros de vida, auto e residencial.',
  maintenance:
    'Consertos, reformas, materiais de construção e prestadores para a casa ou o carro.',
  transport:
    'Combustível, aplicativos de transporte, estacionamento, pedágio e transporte público.',
  utilities:
    'Contas de consumo e serviços da casa: energia, água, internet, telefone e celular.',
  asset_sales: 'Venda de bens como veículo, móveis ou equipamentos.',
  investment_income:
    'Juros, rendimentos e dividendos recebidos de investimentos.',
  other_income:
    'Receita identificada que não se encaixa em nenhuma outra categoria.',
  profit_distribution_income:
    'Lucros da empresa da família distribuídos para a pessoa física.',
  reimbursements:
    'Estornos, créditos de lojas, reembolsos de plano de saúde e restituições.',
  rental_income: 'Aluguéis recebidos de imóveis.',
  salary: 'Salário e renda recorrente do trabalho.',
  services_income:
    'Pagamentos recebidos por serviços prestados, inclusive do exterior.',
  investment: 'Aportes em investimentos feitos como despesa planejada.',
  delivery:
    'Comida pedida por aplicativo e entregue em casa, como iFood (IFD*) e Rappi.',
  leisure:
    'Passeios, esportes, academia recreativa, eventos, aluguel de patinete, clubes e hobbies.',
  other_expense:
    'Despesa identificada que não se encaixa em nenhuma outra categoria.',
  personal_care:
    'Salão, estética, clínica estética, cosméticos de tratamento e academia.',
  pets: 'Pet shop, ração, veterinário e banho e tosa.',
  restaurants:
    'Refeições feitas no local: restaurantes, bares, cafés, padarias e lanchonetes.',
  shopping:
    'Compras de bens: roupas, brinquedos, eletrônicos, livrarias, marketplaces e lojas em geral.',
  subscriptions:
    'Assinaturas recorrentes de streaming, software e serviços digitais.',
  travel: 'Passagens, hospedagem, pacotes e passeios de viagem.',
  reserve: 'Dinheiro separado para a reserva de emergência.',
  fees_interest: 'Tarifas bancárias, IOF, juros, multas e encargos.',
  tax: 'Impostos e tributos: IPTU, IPVA, DARF, taxas de governo.',
}
