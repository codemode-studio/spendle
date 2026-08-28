import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'

import { CategorySelect } from '#/components/category-select'
import { TransferAccountSelect } from '#/components/transfer-account-select'
import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '#/components/ui/dialog'
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '#/components/ui/field'
import { Input } from '#/components/ui/input'
import {
  NativeSelect,
  NativeSelectOptGroup,
  NativeSelectOption,
} from '#/components/ui/native-select'
import { Spinner } from '#/components/ui/spinner'
import { ToggleGroup, ToggleGroupItem } from '#/components/ui/toggle-group'
import type { CategoryOption } from '#/domain/categories'
import {
  currencyFractionDigits,
  formatInstrumentName,
  toCents,
} from '#/domain/finance'
import { createManualTransactionFn } from '#/features/finance/finance.functions'
import { financeQueryKeys } from '#/features/finance/queries'

interface AccountOption {
  id: string
  name: string
  currency: string
  purpose: 'operating' | 'reserve' | 'investment'
}

interface CardOption {
  id: string
  name: string
  currency: string
}

export function ManualTransactionDialog({
  accounts,
  cards,
  categories,
}: {
  accounts: AccountOption[]
  cards: CardOption[]
  categories: CategoryOption[]
}) {
  const targets = [
    ...accounts.map((account) => ({
      value: `account:${account.id}`,
      targetType: 'account' as const,
      id: account.id,
      name: account.name,
      currency: account.currency,
    })),
    ...cards.map((card) => ({
      value: `card:${card.id}`,
      targetType: 'card' as const,
      id: card.id,
      name: card.name,
      currency: card.currency,
    })),
  ]
  const defaultTarget = targets.at(0)?.value ?? ''
  const [open, setOpen] = useState(false)
  const [targetValue, setTargetValue] = useState(defaultTarget)
  const [direction, setDirection] = useState<'inflow' | 'outflow'>('outflow')
  const [categoryId, setCategoryId] = useState('uncategorized')
  const [counterpartyAccountId, setCounterpartyAccountId] = useState<
    string | null
  >(null)
  const [amount, setAmount] = useState('')
  const queryClient = useQueryClient()
  const createManualTransaction = useServerFn(createManualTransactionFn)
  const selectedTarget =
    targets.find((target) => target.value === targetValue) ?? null

  function resetForm() {
    setTargetValue(defaultTarget)
    setDirection('outflow')
    setCategoryId('uncategorized')
    setCounterpartyAccountId(null)
    setAmount('')
  }

  const mutation = useMutation({
    mutationFn: createManualTransaction,
    onSuccess: (result) => {
      if (result.reconciliationRefresh.status === 'deferred') {
        toast.warning(
          'Lançamento salvo. A atualização das conciliações ficou pendente.',
        )
      } else if (result.reopenedCheckpoints > 0) {
        toast.success(
          'Lançamento salvo. Os saldos posteriores precisam ser conferidos novamente.',
        )
      } else {
        toast.success('Lançamento salvo.')
      }
      setOpen(false)
      resetForm()
      void queryClient.invalidateQueries({ queryKey: financeQueryKeys.all })
    },
    onError: (reason) => {
      toast.error(
        reason instanceof Error
          ? reason.message
          : 'Não foi possível salvar o lançamento.',
      )
    },
  })

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selectedTarget) {
      toast.error('Selecione uma conta ou cartão.')
      return
    }
    const form = new FormData(event.currentTarget)
    try {
      const amountCents = toCents(amount, selectedTarget.currency)
      if (amountCents <= 0) throw new Error('Informe um valor maior que zero.')
      if (categoryId === 'transfer' && !counterpartyAccountId) {
        throw new Error('Selecione a outra conta da transferência.')
      }
      mutation.mutate({
        data: {
          targetType: selectedTarget.targetType,
          targetId: selectedTarget.id,
          postedAt: String(form.get('postedAt')),
          description: String(form.get('description')),
          direction,
          amountCents,
          categoryId,
          counterpartyAccountId:
            categoryId === 'transfer'
              ? (counterpartyAccountId ?? undefined)
              : undefined,
          notes: String(form.get('notes') || '') || undefined,
        },
      })
    } catch (reason) {
      toast.error(
        reason instanceof Error ? reason.message : 'Informe um valor válido.',
      )
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button type="button" />}>
        <Plus data-icon="inline-start" />
        Nova transação
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Nova transação</DialogTitle>
            <DialogDescription>
              Registre uma movimentação que não veio de um extrato. O saldo e as
              conferências posteriores serão recalculados.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="manual-transaction-target">
                Conta ou cartão
              </FieldLabel>
              <NativeSelect
                id="manual-transaction-target"
                value={targetValue}
                onChange={(event) => {
                  const nextTargetValue = event.target.value
                  const nextTarget = targets.find(
                    (target) => target.value === nextTargetValue,
                  )
                  setTargetValue(nextTargetValue)
                  setCounterpartyAccountId(null)
                  if (
                    nextTarget?.targetType === 'card' &&
                    categoryId === 'transfer'
                  ) {
                    setCategoryId('uncategorized')
                  }
                }}
                className="w-full"
                required
              >
                {!targets.length ? (
                  <NativeSelectOption value="">
                    Nenhuma conta disponível
                  </NativeSelectOption>
                ) : null}
                {accounts.length ? (
                  <NativeSelectOptGroup label="Contas">
                    {accounts.map((account) => (
                      <NativeSelectOption
                        key={account.id}
                        value={`account:${account.id}`}
                      >
                        {formatInstrumentName(account.name)} ·{' '}
                        {account.currency}
                      </NativeSelectOption>
                    ))}
                  </NativeSelectOptGroup>
                ) : null}
                {cards.length ? (
                  <NativeSelectOptGroup label="Cartões">
                    {cards.map((card) => (
                      <NativeSelectOption
                        key={card.id}
                        value={`card:${card.id}`}
                      >
                        {formatInstrumentName(card.name)} · {card.currency}
                      </NativeSelectOption>
                    ))}
                  </NativeSelectOptGroup>
                ) : null}
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel id="manual-transaction-direction">
                Movimento
              </FieldLabel>
              <ToggleGroup
                aria-labelledby="manual-transaction-direction"
                value={[direction]}
                onValueChange={(values) => {
                  const value = values.at(0)
                  if (value === 'inflow' || value === 'outflow') {
                    setDirection(value)
                  }
                }}
                variant="outline"
              >
                <ToggleGroupItem value="outflow">Saída</ToggleGroupItem>
                <ToggleGroupItem value="inflow">Entrada</ToggleGroupItem>
              </ToggleGroup>
              <FieldDescription>
                Entrada aumenta o saldo. Saída diminui o saldo.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="manual-transaction-description">
                Descrição
              </FieldLabel>
              <Input
                id="manual-transaction-description"
                name="description"
                maxLength={200}
                placeholder="Ex.: Serviço pago em Bitcoin"
                required
              />
            </Field>
            <FieldGroup className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="manual-transaction-amount">
                  Valor
                </FieldLabel>
                <Input
                  id="manual-transaction-amount"
                  name="amount"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  inputMode="decimal"
                  placeholder={
                    selectedTarget &&
                    currencyFractionDigits(selectedTarget.currency) === 8
                      ? '0,00000000'
                      : '0,00'
                  }
                  required
                />
                {selectedTarget ? (
                  <FieldDescription>{selectedTarget.currency}</FieldDescription>
                ) : null}
              </Field>
              <Field>
                <FieldLabel htmlFor="manual-transaction-date">Data</FieldLabel>
                <Input
                  id="manual-transaction-date"
                  name="postedAt"
                  type="date"
                  defaultValue={new Date().toISOString().slice(0, 10)}
                  required
                />
              </Field>
            </FieldGroup>
            <Field>
              <FieldLabel>Categoria</FieldLabel>
              <CategorySelect
                categories={categories}
                value={categoryId}
                onValueChange={(value) => {
                  setCategoryId(value)
                  if (value !== 'transfer') setCounterpartyAccountId(null)
                }}
                allowTransfer={selectedTarget?.targetType === 'account'}
                required
                aria-label="Categoria do lançamento manual"
              />
            </Field>
            {categoryId === 'transfer' &&
            selectedTarget?.targetType === 'account' ? (
              <TransferAccountSelect
                accounts={accounts}
                sourceAccountId={selectedTarget.id}
                amountCents={direction === 'outflow' ? -1 : 1}
                value={counterpartyAccountId}
                disabled={mutation.isPending}
                onValueChange={setCounterpartyAccountId}
              />
            ) : null}
            <Field>
              <FieldLabel htmlFor="manual-transaction-notes">
                Observação opcional
              </FieldLabel>
              <Input
                id="manual-transaction-notes"
                name="notes"
                maxLength={200}
              />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>
              Cancelar
            </DialogClose>
            <Button
              type="submit"
              disabled={mutation.isPending || !targets.length}
            >
              {mutation.isPending ? <Spinner data-icon="inline-start" /> : null}
              {mutation.isPending ? 'Salvando…' : 'Salvar transação'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
