import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { CategorySelect } from '#/components/category-select'
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
import {
  currencyFractionDigits,
  formatMinorUnitsForInput,
  toMinorUnits,
} from '#/domain/currency'
import { formatInstrumentName } from '#/domain/finance'
import { todayIso } from '#/domain/period'
import { isCard } from '#/features/v2/accounts'
import type { AccountView } from '#/features/v2/accounts'
import {
  createManualTransactionFn,
  removeManualTransactionFn,
  reviseManualTransactionFn,
} from '#/features/v2/manual.functions'
import { invalidateAfterReactors } from '#/features/v2/queries'
import { errorMessage } from '#/lib/v2/errors'

import type { Category } from '@spendle/server/api'

/** A typed-in transaction being edited: its manual id and current fields. */
export interface ManualTransactionDraft {
  externalId: string
  accountId: string
  bookedOn: string
  amountCents: number
  description: string
}

/**
 * Registers a movement no statement or bank reported, or corrects or
 * deletes one typed in before. V2 keeps every version; once the bank
 * reports the same movement, both become one entry.
 */
export function ManualTransactionDialog({
  accounts,
  categories,
  open: controlledOpen,
  onOpenChange,
  trigger,
  defaultDirection = 'outflow',
  defaultAccountId,
  editing,
  onSaved,
}: {
  /** Active accounts and cards the person may type into. */
  accounts: ReadonlyArray<AccountView>
  /** Categories a person may choose. */
  categories: ReadonlyArray<Category>
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** `undefined` renders the default button; `null` renders none. */
  trigger?: React.ReactElement | null
  defaultDirection?: 'inflow' | 'outflow'
  defaultAccountId?: string
  editing?: ManualTransactionDraft | null
  onSaved?: (result: { entryId: string | null }) => void
}) {
  const [internalOpen, setInternalOpen] = useState(false)
  const open = controlledOpen ?? internalOpen
  const setOpen = (nextOpen: boolean) => {
    if (controlledOpen === undefined) setInternalOpen(nextOpen)
    onOpenChange?.(nextOpen)
  }
  const bankAccounts = accounts.filter((account) => !isCard(account))
  const cards = accounts.filter(isCard)
  const initialAccount =
    editing?.accountId ??
    defaultAccountId ??
    bankAccounts.at(0)?.id ??
    cards.at(0)?.id ??
    ''
  const [accountId, setAccountId] = useState(initialAccount)
  const [direction, setDirection] = useState<'inflow' | 'outflow'>(
    editing
      ? editing.amountCents > 0
        ? 'inflow'
        : 'outflow'
      : defaultDirection,
  )
  const [categoryId, setCategoryId] = useState('uncategorized')
  const account = accounts.find((item) => item.id === accountId) ?? null
  const currency = account?.currency ?? 'BRL'
  const [amount, setAmount] = useState(
    editing
      ? formatMinorUnitsForInput(Math.abs(editing.amountCents), currency)
      : '',
  )
  const queryClient = useQueryClient()
  const create = useServerFn(createManualTransactionFn)
  const revise = useServerFn(reviseManualTransactionFn)
  const remove = useServerFn(removeManualTransactionFn)

  function reset() {
    setAccountId(initialAccount)
    setDirection(defaultDirection)
    setCategoryId('uncategorized')
    setAmount('')
  }

  const save = useMutation({
    mutationFn: (input: {
      bookedOn: string
      amountCents: number
      description: string
      note: string
    }) =>
      editing
        ? revise({
            data: {
              externalId: editing.externalId,
              bookedOn: input.bookedOn,
              amountCents: input.amountCents,
              description: input.description,
            },
          })
        : create({
            data: {
              accountId,
              bookedOn: input.bookedOn,
              amountCents: input.amountCents,
              description: input.description,
              categoryId:
                categoryId === 'uncategorized' ? undefined : categoryId,
              note: input.note || undefined,
            },
          }),
    onSuccess: (result) => {
      toast.success(editing ? 'Lançamento corrigido.' : 'Lançamento salvo.')
      setOpen(false)
      if (!editing) reset()
      void invalidateAfterReactors(queryClient)
      onSaved?.({ entryId: result.entryId })
    },
    onError: (reason) =>
      toast.error(
        errorMessage(reason, 'Não foi possível salvar o lançamento.'),
      ),
  })

  const deletion = useMutation({
    mutationFn: () => remove({ data: { externalId: editing!.externalId } }),
    onSuccess: () => {
      toast.success('Lançamento excluído. O histórico continua salvo.')
      setOpen(false)
      void invalidateAfterReactors(queryClient)
    },
    onError: (reason) =>
      toast.error(
        errorMessage(reason, 'Não foi possível excluir o lançamento.'),
      ),
  })

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!account) {
      toast.error('Selecione uma conta ou cartão.')
      return
    }
    const form = new FormData(event.currentTarget)
    try {
      const cents = toMinorUnits(amount, currency)
      if (cents <= 0) throw new Error('Informe um valor maior que zero.')
      const description = String(form.get('description')).trim()
      if (description.length < 2)
        throw new Error('Descreva o lançamento com ao menos 2 letras.')
      save.mutate({
        bookedOn: String(form.get('bookedOn')),
        amountCents: direction === 'inflow' ? cents : -cents,
        description,
        note: String(form.get('note') ?? '').trim(),
      })
    } catch (reason) {
      toast.error(errorMessage(reason, 'Informe um valor válido.'))
    }
  }

  const pending = save.isPending || deletion.isPending
  const idPrefix = editing ? `manual-${editing.externalId}` : 'manual-new'

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger === undefined ? (
        <DialogTrigger render={<Button type="button" />}>
          <Plus data-icon="inline-start" />
          Nova transação
        </DialogTrigger>
      ) : trigger ? (
        <DialogTrigger render={trigger} />
      ) : null}
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>
              {editing ? 'Corrigir lançamento' : 'Nova transação'}
            </DialogTitle>
            <DialogDescription>
              {editing
                ? 'Digitado por você. Quando o banco informar o mesmo movimento, os dois viram um só.'
                : 'Para o que não veio de extrato nem do banco. Quando o banco informar o mesmo movimento, os dois viram um só.'}
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`${idPrefix}-account`}>
                Conta ou cartão
              </FieldLabel>
              <NativeSelect
                id={`${idPrefix}-account`}
                value={accountId}
                onChange={(event) => setAccountId(event.target.value)}
                className="w-full"
                disabled={Boolean(editing)}
                required
              >
                {!accounts.length ? (
                  <NativeSelectOption value="">
                    Nenhuma conta disponível
                  </NativeSelectOption>
                ) : null}
                {bankAccounts.length ? (
                  <NativeSelectOptGroup label="Contas">
                    {bankAccounts.map((item) => (
                      <NativeSelectOption key={item.id} value={item.id}>
                        {formatInstrumentName(item.name)} · {item.currency}
                      </NativeSelectOption>
                    ))}
                  </NativeSelectOptGroup>
                ) : null}
                {cards.length ? (
                  <NativeSelectOptGroup label="Cartões">
                    {cards.map((item) => (
                      <NativeSelectOption key={item.id} value={item.id}>
                        {formatInstrumentName(item.name)} · {item.currency}
                      </NativeSelectOption>
                    ))}
                  </NativeSelectOptGroup>
                ) : null}
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel id={`${idPrefix}-direction`}>Movimento</FieldLabel>
              <ToggleGroup
                aria-labelledby={`${idPrefix}-direction`}
                value={[direction]}
                onValueChange={(values) => {
                  const value = values.at(0)
                  if (value === 'inflow' || value === 'outflow')
                    setDirection(value)
                }}
                variant="outline"
              >
                <ToggleGroupItem value="outflow">Saída</ToggleGroupItem>
                <ToggleGroupItem value="inflow">Entrada</ToggleGroupItem>
              </ToggleGroup>
            </Field>
            <Field>
              <FieldLabel htmlFor={`${idPrefix}-description`}>
                Descrição
              </FieldLabel>
              <Input
                id={`${idPrefix}-description`}
                name="description"
                maxLength={200}
                minLength={2}
                placeholder="Ex.: Feira paga em dinheiro"
                defaultValue={editing?.description}
                required
              />
            </Field>
            <FieldGroup className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor={`${idPrefix}-amount`}>Valor</FieldLabel>
                <Input
                  id={`${idPrefix}-amount`}
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  inputMode="decimal"
                  placeholder={
                    currencyFractionDigits(currency) === 8
                      ? '0,00000000'
                      : '0,00'
                  }
                  required
                />
                <FieldDescription>{currency}</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor={`${idPrefix}-date`}>Data</FieldLabel>
                <Input
                  id={`${idPrefix}-date`}
                  name="bookedOn"
                  type="date"
                  defaultValue={editing?.bookedOn ?? todayIso()}
                  required
                />
              </Field>
            </FieldGroup>
            {editing ? null : (
              <>
                <Field>
                  <FieldLabel>Categoria</FieldLabel>
                  <CategorySelect
                    categories={[...categories]}
                    value={categoryId}
                    onValueChange={setCategoryId}
                    allowTransfer={false}
                    aria-label="Categoria do lançamento"
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`${idPrefix}-note`}>Nota</FieldLabel>
                  <Input id={`${idPrefix}-note`} name="note" maxLength={500} />
                </Field>
              </>
            )}
          </FieldGroup>
          <DialogFooter className={editing ? 'sm:justify-between' : undefined}>
            {editing ? (
              <Button
                type="button"
                variant="ghost"
                className="text-destructive"
                disabled={pending}
                onClick={() => deletion.mutate()}
              >
                {deletion.isPending ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <Trash2 data-icon="inline-start" />
                )}
                Excluir
              </Button>
            ) : null}
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <DialogClose render={<Button type="button" variant="outline" />}>
                Cancelar
              </DialogClose>
              <Button type="submit" disabled={pending || !accounts.length}>
                {save.isPending ? <Spinner data-icon="inline-start" /> : null}
                {editing ? 'Salvar correção' : 'Salvar transação'}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
