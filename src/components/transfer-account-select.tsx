import { ArrowLeft, ArrowRight, Info } from 'lucide-react'

import { Button } from '#/components/ui/button'
import { Field, FieldDescription, FieldLabel } from '#/components/ui/field'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#/components/ui/select'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '#/components/ui/tooltip'
import { formatInstrumentName } from '#/domain/finance'

interface TransferAccount {
  id: string
  name: string
  purpose?: 'operating' | 'reserve' | 'investment'
}

export function TransferAccountSelect({
  accounts,
  sourceAccountId,
  amountCents,
  value,
  disabled,
  onValueChange,
}: {
  accounts: TransferAccount[]
  sourceAccountId: string | null
  amountCents: number
  value: string | null
  disabled?: boolean
  onValueChange: (accountId: string) => void
}) {
  const availableAccounts = accounts.filter(
    (account) => account.id !== sourceAccountId,
  )
  const outgoing = amountCents < 0
  const label = outgoing ? 'Conta de destino' : 'Conta de origem'
  const shortLabel = outgoing ? 'Destino' : 'Origem'
  const items = availableAccounts.map((account) => ({
    label: `${formatInstrumentName(account.name)}${
      account.purpose === 'investment'
        ? ' · Investimentos'
        : account.purpose === 'reserve'
          ? ' · Reserva'
          : ''
    }`,
    value: account.id,
  }))

  return (
    <Field data-invalid={!value} className="gap-1">
      <FieldLabel className="sr-only">{label}</FieldLabel>
      <div className="flex max-w-72 items-center gap-1.5">
        <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground">
          {outgoing ? (
            <ArrowRight aria-hidden="true" className="size-3.5" />
          ) : (
            <ArrowLeft aria-hidden="true" className="size-3.5" />
          )}
          {shortLabel}
        </span>
        <Select
          items={items}
          value={value}
          onValueChange={(accountId) => {
            if (accountId) onValueChange(accountId)
          }}
        >
          <SelectTrigger
            size="sm"
            className="min-w-0 flex-1"
            aria-label={label}
            aria-invalid={!value}
            disabled={disabled || !availableAccounts.length}
          >
            <SelectValue placeholder="Selecionar conta" />
          </SelectTrigger>
          <SelectContent align="start" alignItemWithTrigger={false}>
            <SelectGroup>
              {items.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Como funciona a conciliação"
              />
            }
          >
            <Info aria-hidden="true" />
          </TooltipTrigger>
          <TooltipContent side="top">
            Ao importar a outra conta, inclusive uma conta de investimento, o
            sistema concilia as duas pontas sem contar o aporte como renda ou
            despesa.
          </TooltipContent>
        </Tooltip>
      </div>
      {!value ? (
        <FieldDescription className="text-xs">
          Selecione a conta relacionada.
        </FieldDescription>
      ) : null}
    </Field>
  )
}
