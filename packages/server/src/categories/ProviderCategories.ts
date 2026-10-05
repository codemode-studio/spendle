/**
 * Pluggy categories that name one of ours without doubt, by Pluggy's
 * English category name (its documented category tree). Only a suggestion
 * for review: the person's own mapping (`KnowledgeStore.setProviderMapping`,
 * keyed on Pluggy's category id) is what applies automatically.
 *
 * Deliberately short. Broad parents (`Shopping`, `Services`, `Leisure`),
 * transfers (reconciliation's), investments and anything that could be
 * either a person's or a company's money are left out.
 */
export const builtInProviderCategories: ReadonlyMap<string, string> = new Map([
  ['Groceries', 'groceries'],
  ['Eating out', 'restaurants'],
  ['Food delivery', 'delivery'],
  ['Pharmacy', 'health'],
  ['Dentist', 'health'],
  ['Hospital clinics and labs', 'health'],
  ['Gas stations', 'transport'],
  ['Parking', 'transport'],
  ['Tolls and in-vehicle payment', 'transport'],
  ['Taxi and ride-hailing', 'transport'],
  ['Public transportation', 'transport'],
  ['Airport and airlines', 'travel'],
  ['Accommodation', 'travel'],
  ['Video streaming', 'subscriptions'],
  ['Music streaming', 'subscriptions'],
  ['Rent', 'housing'],
  ['Electricity', 'utilities'],
  ['Water', 'utilities'],
  ['Internet', 'utilities'],
  ['Mobile', 'utilities'],
  ['Account fees', 'fees_interest'],
  ['Credit card fees', 'fees_interest'],
  ['Interests charged', 'fees_interest'],
  ['Late payment and overdraft costs', 'fees_interest'],
  ['Income taxes', 'tax'],
  ['Salary', 'salary'],
])

/** The provider every observation's category currently comes from. */
export const pluggyProvider = 'pluggy'
