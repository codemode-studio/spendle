import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { CalendarCheck } from 'lucide-react'
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
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '#/components/ui/field'
import { Input } from '#/components/ui/input'
import { NativeSelect } from '#/components/ui/native-select'
import { currencyFractionDigits, toCents } from '#/domain/finance'
import { createManualBalanceCheckpointFn } from '#/features/finance/finance.functions'
import { financeQueryKeys } from '#/features/finance/queries'

export function BalanceCheckpointDialog({
  targetType,
  targetId,
  targetName,
  targetCurrency,
}: {
  targetType: 'account' | 'card'
  targetId: string
  targetName: string
  targetCurrency: string
}) {
  const [open, setOpen] = useState(false)
  const [replaceExisting, setReplaceExisting] = useState(false)
  const queryClient = useQueryClient()
  const createCheckpoint = useServerFn(createManualBalanceCheckpointFn)
  const mutation = useMutation({
    mutationFn: createCheckpoint,
    onSuccess: (result) => {
      toast.success(result.message)
      setOpen(false)
      setReplaceExisting(false)
      queryClient.invalidateQueries({ queryKey: financeQueryKeys.all })
    },
    onError: (reason) => {
      if (
        reason instanceof Error &&
        reason.message.includes('Confirme a substituição')
      ) {
        setReplaceExisting(true)
      }
      toast.error(
        reason instanceof Error
          ? reason.message
          : 'Não foi possível registrar o saldo.',
      )
    },
  })

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    mutation.mutate({
      data: {
        targetType,
        targetId,
        balanceCents: toCents(String(form.get('balance')), targetCurrency),
        asOf: String(form.get('asOf')),
        periodStart:
          targetType === 'card' ? String(form.get('periodStart')) : undefined,
        balanceType:
          targetType === 'card'
            ? 'card_statement'
            : (String(form.get('balanceType')) as 'posted' | 'available'),
        note: String(form.get('note') || '') || undefined,
        replaceExisting,
      },
    })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen)
        if (!nextOpen) setReplaceExisting(false)
      }}
    >
      <DialogTrigger
        render={<Button type="button" variant="outline" size="sm" />}
      >
        <CalendarCheck data-icon="inline-start" />
        {targetType === 'account' ? 'Confirmar saldo' : 'Confirmar fatura'}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>
              {targetType === 'account'
                ? 'Confirmar saldo datado'
                : 'Confirmar fatura fechada'}
            </DialogTitle>
            <DialogDescription>
              Informe exatamente o valor exibido em {targetName}. O sistema
              compara com as movimentações e nunca cria ajuste automático.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`checkpoint-balance-${targetId}`}>
                {targetType === 'account' ? 'Saldo' : 'Total da fatura'}
              </FieldLabel>
              <Input
                id={`checkpoint-balance-${targetId}`}
                name="balance"
                inputMode="decimal"
                placeholder={
                  currencyFractionDigits(targetCurrency) === 8
                    ? '0,00000000'
                    : '0,00'
                }
                autoFocus
                required
              />
            </Field>
            {targetType === 'card' ? (
              <Field>
                <FieldLabel htmlFor={`checkpoint-period-start-${targetId}`}>
                  Início do ciclo
                </FieldLabel>
                <Input
                  id={`checkpoint-period-start-${targetId}`}
                  name="periodStart"
                  type="date"
                  required
                />
                <FieldDescription>
                  Use o primeiro dia incluído nesta fatura. Só os lançamentos
                  desse intervalo serão conferidos e fechados.
                </FieldDescription>
              </Field>
            ) : null}
            <Field>
              <FieldLabel htmlFor={`checkpoint-date-${targetId}`}>
                {targetType === 'card' ? 'Fechamento' : 'Data do saldo'}
              </FieldLabel>
              <Input
                id={`checkpoint-date-${targetId}`}
                name="asOf"
                type="date"
                defaultValue={new Date().toISOString().slice(0, 10)}
                required
              />
              <FieldDescription>
                {targetType === 'card'
                  ? 'Use a data de fechamento mostrada na fatura.'
                  : 'Use a data mostrada pelo banco junto ao saldo.'}
              </FieldDescription>
            </Field>
            {targetType === 'account' ? (
              <Field>
                <FieldLabel htmlFor={`checkpoint-type-${targetId}`}>
                  Tipo de saldo
                </FieldLabel>
                <NativeSelect
                  id={`checkpoint-type-${targetId}`}
                  name="balanceType"
                  className="w-full"
                  defaultValue="posted"
                >
                  <option value="posted">Saldo contabilizado</option>
                  <option value="available">Saldo disponível</option>
                </NativeSelect>
                <FieldDescription>
                  O saldo disponível é guardado como referência, mas não valida
                  o livro contábil.
                </FieldDescription>
              </Field>
            ) : null}
            <Field>
              <FieldLabel htmlFor={`checkpoint-note-${targetId}`}>
                Observação opcional
              </FieldLabel>
              <Input
                id={`checkpoint-note-${targetId}`}
                name="note"
                maxLength={200}
              />
            </Field>
          </FieldGroup>
          {replaceExisting ? (
            <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              Já existe outro valor nesta data. Ao substituir, esse ponto e as
              conferências posteriores serão invalidados no histórico.
            </p>
          ) : null}
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>
              Cancelar
            </DialogClose>
            <Button
              type="submit"
              variant={replaceExisting ? 'destructive' : 'default'}
              disabled={mutation.isPending}
            >
              {mutation.isPending
                ? 'Conferindo…'
                : replaceExisting
                  ? 'Substituir e conferir'
                  : 'Registrar e conferir'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
