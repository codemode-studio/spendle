import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { RefreshCw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

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
import { Field, FieldGroup, FieldLabel } from '#/components/ui/field'
import { Input } from '#/components/ui/input'
import { Spinner } from '#/components/ui/spinner'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '#/components/ui/tooltip'
import {
  currencyFractionDigits,
  formatCurrency,
  toMinorUnits,
} from '#/domain/currency'
import { formatInstrumentName } from '#/domain/finance'
import { formatShortDate, todayIso } from '#/domain/period'
import type { AccountView } from '#/features/v2/accounts'
import {
  recordCheckpointFn,
  withdrawCheckpointFn,
} from '#/features/v2/manual.functions'
import {
  balanceProofOptions,
  invalidateAfterReactors,
} from '#/features/v2/queries'
import { errorMessage } from '#/lib/v2/errors'

/**
 * The balance the person sees at the bank, for an account no statement or
 * Open Finance keeps current. The balance proof checks the movements
 * against it like a statement's closing balance; a difference shows as a
 * gap on the account.
 */
export function BalanceCheckpointDialog({ account }: { account: AccountView }) {
  const [open, setOpen] = useState(false)
  // A new form each time the dialog opens, so nothing typed before lingers.
  const [opened, setOpened] = useState(0)
  const queryClient = useQueryClient()
  const record = useServerFn(recordCheckpointFn)
  const withdraw = useServerFn(withdrawCheckpointFn)
  const proof = useQuery({ ...balanceProofOptions(account.id), enabled: open })
  const informed = proof.data?.supported
    ? proof.data.checkpoints
        .filter((checkpoint) => checkpoint.sourceKind === 'manual')
        .reverse()
    : []
  const name = formatInstrumentName(account.name)
  const saved = useMutation({
    mutationFn: record,
    onSuccess: () => {
      toast.success('Saldo informado. A conferência foi refeita.')
      setOpen(false)
      void invalidateAfterReactors(queryClient)
    },
    onError: (reason) =>
      toast.error(errorMessage(reason, 'Não foi possível informar o saldo.')),
  })
  const withdrawn = useMutation({
    mutationFn: withdraw,
    onSuccess: () => {
      toast.success('Saldo retirado da conferência.')
      void invalidateAfterReactors(queryClient)
    },
    onError: (reason) =>
      toast.error(errorMessage(reason, 'Não foi possível retirar o saldo.')),
  })

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    try {
      saved.mutate({
        data: {
          accountId: account.id,
          asOf: String(form.get('asOf')),
          balanceCents: toMinorUnits(
            String(form.get('balance')),
            account.currency,
          ),
        },
      })
    } catch (reason) {
      toast.error(errorMessage(reason, 'Informe um valor válido.'))
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) setOpened((count) => count + 1)
        setOpen(nextOpen)
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <DialogTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Informar saldo de ${name}`}
                />
              }
            />
          }
        >
          <RefreshCw />
        </TooltipTrigger>
        <TooltipContent>Informar saldo</TooltipContent>
      </Tooltip>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md">
        <form key={opened} onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Informar saldo · {name}</DialogTitle>
            <DialogDescription>
              O saldo que o banco mostra no fim do dia. Os lançamentos são
              conferidos contra ele.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor={`checkpoint-${account.id}-balance`}>
                Saldo em {account.currency}
              </FieldLabel>
              <Input
                id={`checkpoint-${account.id}-balance`}
                name="balance"
                inputMode="decimal"
                placeholder={
                  currencyFractionDigits(account.currency) === 8
                    ? '0,00000000'
                    : '0,00'
                }
                required
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`checkpoint-${account.id}-date`}>
                No fim de
              </FieldLabel>
              <Input
                id={`checkpoint-${account.id}-date`}
                name="asOf"
                type="date"
                defaultValue={todayIso()}
                max={todayIso()}
                required
              />
            </Field>
          </FieldGroup>
          {informed.length > 0 ? (
            <section aria-label="Saldos já informados">
              <h3 className="mb-1.5 text-xs font-medium text-muted-foreground">
                Informados por você
              </h3>
              <ul className="divide-y rounded-lg border text-sm">
                {informed.map((checkpoint) => (
                  <li
                    key={checkpoint.id}
                    className="flex items-center justify-between gap-3 py-1 pr-1 pl-3"
                  >
                    <span className="text-muted-foreground">
                      {formatShortDate(checkpoint.asOf)}
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="tabular-nums">
                        {formatCurrency(
                          checkpoint.balanceCents,
                          account.currency,
                        )}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        disabled={withdrawn.isPending}
                        aria-label={`Retirar saldo de ${formatShortDate(checkpoint.asOf)}`}
                        title="Retirar da conferência"
                        onClick={() =>
                          withdrawn.mutate({
                            data: { checkpointId: checkpoint.id },
                          })
                        }
                      >
                        <Trash2 />
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>
              Cancelar
            </DialogClose>
            <Button type="submit" disabled={saved.isPending}>
              {saved.isPending ? <Spinner data-icon="inline-start" /> : null}
              Salvar saldo
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
