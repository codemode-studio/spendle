import { UserPlus, UserRound, X } from 'lucide-react'
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { useState } from 'react'
import { toast } from 'sonner'

import { Panel, StatusBadge } from '#/components/ui'
import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
import { Field, FieldGroup, FieldLabel } from '#/components/ui/field'
import { Input } from '#/components/ui/input'
import { addMemberFn, removeMemberFn } from '#/features/v2/space.functions'
import { spaceOptions } from '#/features/v2/queries'
import { errorMessage } from '#/lib/v2/errors'

/** Who can see this family's data; the owner adds and removes people. */
export function MembersPanel() {
  const { data: space } = useSuspenseQuery(spaceOptions())
  const queryClient = useQueryClient()
  const addMember = useServerFn(addMemberFn)
  const removeMember = useServerFn(removeMemberFn)
  const [dialogOpen, setDialogOpen] = useState(false)

  const isOwner = space.members.some(
    (member) => member.email === space.you && member.role === 'owner',
  )
  const onChanged = (next: typeof space) =>
    queryClient.setQueryData(spaceOptions().queryKey, next)

  const adding = useMutation({
    mutationFn: addMember,
    onSuccess: (next, { data }) => {
      onChanged(next)
      setDialogOpen(false)
      toast.success(`${data.email} agora vê os dados da família.`)
    },
    onError: (error) =>
      toast.error(errorMessage(error, 'Não foi possível adicionar.')),
  })
  const removing = useMutation({
    mutationFn: removeMember,
    onSuccess: (next, { data }) => {
      onChanged(next)
      toast.success(`${data.email} não vê mais os dados da família.`)
    },
    onError: (error) =>
      toast.error(errorMessage(error, 'Não foi possível remover.')),
  })

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const email = String(new FormData(event.currentTarget).get('email'))
    adding.mutate({ data: { email: email.trim().toLowerCase() } })
  }

  return (
    <Panel
      title="Pessoas com acesso"
      action={
        isOwner ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setDialogOpen(true)}
          >
            <UserPlus data-icon="inline-start" />
            Adicionar
          </Button>
        ) : undefined
      }
    >
      <div className="divide-y overflow-hidden rounded-lg border">
        {space.members.map((member) => (
          <div
            key={member.email}
            className="flex items-center justify-between gap-3 px-3 py-3"
          >
            <div className="flex min-w-0 items-center gap-2.5">
              <UserRound className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate text-sm font-medium">
                {member.email}
              </span>
              {member.email === space.you && (
                <span className="text-xs text-muted-foreground">Você</span>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {member.role === 'owner' && <StatusBadge>Criou</StatusBadge>}
              {isOwner && member.role !== 'owner' && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remover ${member.email}`}
                  disabled={removing.isPending}
                  onClick={() =>
                    removing.mutate({ data: { email: member.email } })
                  }
                >
                  <X />
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <form onSubmit={submit} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Adicionar pessoa</DialogTitle>
              <DialogDescription>
                Ela entra com essa conta Google e vê todos os dados da família.
              </DialogDescription>
            </DialogHeader>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="member-email">E-mail do Google</FieldLabel>
                <Input
                  id="member-email"
                  name="email"
                  type="email"
                  placeholder="nome@gmail.com"
                  required
                  autoFocus
                />
              </Field>
            </FieldGroup>
            <DialogFooter>
              <DialogClose render={<Button type="button" variant="outline" />}>
                Cancelar
              </DialogClose>
              <Button type="submit" disabled={adding.isPending}>
                <UserPlus data-icon="inline-start" />
                {adding.isPending ? 'Adicionando…' : 'Adicionar'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Panel>
  )
}
