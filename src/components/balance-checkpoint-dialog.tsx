import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { CalendarCheck, RefreshCw, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'

import { Alert, AlertDescription, AlertTitle } from '#/components/ui/alert'
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
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '#/components/ui/tooltip'
import {
  currencyFractionDigits,
  toMinorUnits as toCents,
} from '#/domain/currency'
import { createManualBalanceCheckpointFn } from '#/features/finance/finance.functions'
import { financeQueryKeys } from '#/features/finance/queries'

export function BalanceCheckpointDialog({
  targetType,
  targetId,
  targetName,
  targetCurrency,
  trigger = 'button',
}: {
  targetType: 'account' | 'card'
  targetId: string
  targetName: string
  targetCurrency: string
  /** `icon` renders só o ícone com tooltip, para caber no cabeçalho de um card. */
  trigger?: 'button' | 'icon'
}) {
  const label =
    targetType === 'account' ? 'Atualizar saldo' : 'Confirmar fatura'
  const Icon = targetType === 'account' ? RefreshCw : CalendarCheck
  const [open, setOpen] = useState(false)
  const [replaceExisting, setReplaceExisting] = useState(false)
  const queryClient = useQueryClient()
  const createCheckpoint = useServerFn(createManualBalanceCheckpointFn)
  const mutation = useMutation({
    mutationFn: createCheckpoint,
    onSuccess: (result) => {
      if (targetType === 'account') {
        if (result.differenceCents) {
          toast.warning('Saldo atualizado. Há uma diferença no extrato.')
        } else if (result.reviewState === 'verified') {
          toast.success('Saldo atualizado e extrato conferido.')
        } else {
          toast.success('Saldo atualizado.')
        }
      } else {
        toast.success(result.message)
      }
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
        balanceType: targetType === 'card' ? 'card_statement' : 'posted',
        note:
          targetType === 'card'
            ? String(form.get('note') || '') || undefined
            : undefined,
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
      {trigger === 'icon' ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <DialogTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`${label}: ${targetName}`}
                  />
                }
              />
            }
          >
            <Icon />
          </TooltipTrigger>
          <TooltipContent>{label}</TooltipContent>
        </Tooltip>
      ) : (
        <DialogTrigger
          render={<Button type="button" variant="outline" size="sm" />}
        >
          <Icon data-icon="inline-start" />
          {label}
        </DialogTrigger>
      )}
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>
              {targetType === 'account'
                ? 'Atualizar saldo'
                : 'Confirmar fatura fechada'}
            </DialogTitle>
            <DialogDescription>
              {targetType === 'account'
                ? `Informe o saldo exibido em ${targetName} e a data desse valor. O app confere os extratos disponíveis automaticamente.`
                : `Informe exatamente o total exibido em ${targetName}. O app compara esse valor com os lançamentos da fatura.`}
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`checkpoint-balance-${targetId}`}>
                {targetType === 'account' ? 'Saldo atual' : 'Total da fatura'}
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
                  : 'Use a data à qual o saldo se refere.'}
              </FieldDescription>
            </Field>
            {targetType === 'card' ? (
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
            ) : null}
          </FieldGroup>
          {replaceExisting ? (
            <Alert variant="destructive">
              <TriangleAlert />
              <AlertTitle>Já existe um saldo nessa data</AlertTitle>
              <AlertDescription>
                Ao substituir, o app recalculará as conferências posteriores.
              </AlertDescription>
            </Alert>
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
                ? 'Salvando…'
                : targetType === 'account'
                  ? replaceExisting
                    ? 'Substituir saldo'
                    : 'Salvar saldo'
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
