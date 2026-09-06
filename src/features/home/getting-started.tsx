import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { ArrowRight } from 'lucide-react'
import { Button } from '#/components/ui/button'
import { Panel } from '#/components/ui'
import {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '#/components/ui/sheet'
import type { FinanceSnapshot } from '#/features/finance/snapshot.types'

export function GettingStarted({ snapshot }: { snapshot: FinanceSnapshot }) {
  const [open, setOpen] = useState(false)
  const hasAccounts = snapshot.accounts.length > 0
  const hasTransactions = snapshot.transactions.length > 0
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger render={<Button variant="outline" />}>
        Guia de configuração
      </SheetTrigger>
      <SheetContent className="overflow-y-auto data-[side=right]:w-full sm:max-w-lg">
        <SheetHeader className="pr-14">
          <SheetTitle>Organize suas finanças</SheetTitle>
          <SheetDescription>
            Comece por uma conta e um extrato. Continue no seu ritmo.
          </SheetDescription>
        </SheetHeader>
        <div
          className="flex flex-col gap-4 px-4 pb-6"
          onClick={(event) => {
            if ((event.target as HTMLElement).closest('a')) setOpen(false)
          }}
        >
          <Panel
            title="1. Cadastre suas contas"
            description={
              hasAccounts
                ? `${snapshot.accounts.length} ${snapshot.accounts.length === 1 ? 'conta cadastrada' : 'contas cadastradas'}. Adicione cartões se precisar.`
                : 'Informe onde você movimenta seu dinheiro.'
            }
          >
            <Button
              variant={hasAccounts ? 'outline' : 'default'}
              nativeButton={false}
              render={<Link to="/configuracoes" search={{ tab: 'contas' }} />}
            >
              Contas e saldos <ArrowRight />
            </Button>
            <Button
              variant="ghost"
              nativeButton={false}
              render={<Link to="/configuracoes" search={{ tab: 'cartoes' }} />}
            >
              Cartões
            </Button>
          </Panel>
          <Panel
            title="2. Importe um extrato"
            description={
              hasTransactions
                ? 'Já há lançamentos. Importe outros períodos para completar o histórico.'
                : 'Envie um arquivo do banco. Confira a conciliação antes de confirmar.'
            }
          >
            <Button
              variant={hasAccounts && !hasTransactions ? 'default' : 'outline'}
              nativeButton={false}
              render={<Link to="/importar" />}
            >
              Importar e revisar <ArrowRight />
            </Button>
          </Panel>
          <Panel
            title="3. Confira as categorias"
            description="Revise os lançamentos sem categoria. Suas escolhas orientam as próximas importações."
          >
            <Button
              variant="outline"
              nativeButton={false}
              render={
                <Link to="/transacoes" search={{ category: 'uncategorized' }} />
              }
            >
              Revisar lançamentos <ArrowRight />
            </Button>
          </Panel>
          <Panel
            title="4. Organize os próximos meses"
            description={`${snapshot.recurrences.length} recorrências cadastradas. Confira valores e vencimentos; o orçamento é opcional.`}
          >
            <Button
              variant="outline"
              nativeButton={false}
              render={
                <Link to="/planejamento" search={{ section: 'recurrences' }} />
              }
            >
              Recorrências <ArrowRight />
            </Button>
            <Button
              variant="ghost"
              nativeButton={false}
              render={
                <Link to="/planejamento" search={{ section: 'budget' }} />
              }
            >
              Definir orçamento
            </Button>
          </Panel>
        </div>
      </SheetContent>
    </Sheet>
  )
}
