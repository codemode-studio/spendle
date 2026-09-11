import { createFileRoute, Link } from '@tanstack/react-router'
import { Check, Download, Sparkles, X } from 'lucide-react'

import { SpendleLogo } from '#/components/spendle-logo'
import { Badge } from '#/components/ui/badge'
import { buttonVariants } from '#/components/ui/button'
import { cn } from '#/lib/utils'

export const Route = createFileRoute('/marca')({
  head: () => ({
    meta: [
      { title: 'Identidade visual · Spendle' },
      {
        name: 'description',
        content: 'Logo, cores, tipografia e voz da Spendle.',
      },
    ],
  }),
  component: BrandPage,
})

const colors = [
  ['Azul Spendle', '#263F68', '--primary'],
  ['Azul névoa', '#EDF2F9', '--sidebar'],
  ['Papel', '#F5F7F4', '--bg'],
  ['Superfície', '#FFFFFF', '--surface'],
  ['Tinta', '#172438', '--text'],
  ['Texto secundário', '#596579', '--muted-foreground'],
  ['Verde saldo', '#155F38', '--accent-strong'],
  ['Âmbar atenção', '#9A650B', '--amber'],
  ['Vermelho alerta', '#B33B35', '--red'],
] as const

const logoRules = [
  ['Respiro', '½ da altura da marca em todos os lados.'],
  ['Mínimo', '24 px para o brandmark; 96 px para o wordmark.'],
  ['Cor', 'Azul sobre claro; gelo sobre azul ou tinta.'],
  ['Nunca', 'Distorcer, rotacionar, contornar ou aplicar efeitos.'],
] as const

function SectionHeading({
  eyebrow,
  title,
}: Readonly<{
  eyebrow: string
  title: string
}>) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-[0.6875rem] font-semibold tracking-[0.16em] text-primary uppercase">
        {eyebrow}
      </p>
      <h2 className="font-heading text-xl font-medium tracking-tight sm:text-2xl">
        {title}
      </h2>
    </div>
  )
}

function BrandSection({
  id,
  eyebrow,
  title,
  children,
}: Readonly<{
  id: string
  eyebrow: string
  title: string
  children: React.ReactNode
}>) {
  return (
    <section
      id={id}
      className="scroll-mt-6 border-t py-10 sm:py-12 lg:grid lg:grid-cols-[11rem_minmax(0,1fr)] lg:gap-12"
    >
      <SectionHeading eyebrow={eyebrow} title={title} />
      <div className="mt-6 min-w-0 lg:mt-0">{children}</div>
    </section>
  )
}

function DownloadLink({
  href,
  children,
}: Readonly<{ href: string; children: React.ReactNode }>) {
  return (
    <a
      href={href}
      download
      className={cn(buttonVariants({ variant: 'outline' }))}
    >
      <Download data-icon="inline-start" />
      {children}
    </a>
  )
}

function BrandPage() {
  return (
    <div className="mx-auto w-full max-w-[1180px] px-5 pb-16 sm:px-8 sm:pb-24 lg:px-12">
      <header className="flex h-20 items-center justify-between">
        <Link
          to="/"
          aria-label="Ir para a visão geral"
          className="flex min-h-11 items-center text-primary outline-none transition-opacity hover:opacity-75 focus-visible:ring-2 focus-visible:ring-ring"
        >
          <SpendleLogo variant="wordmark" className="h-8 w-32" />
        </Link>
        <nav
          aria-label="Seções da identidade visual"
          className="hidden items-center gap-5 text-sm text-muted-foreground md:flex"
        >
          <a className="hover:text-foreground" href="#logo">
            Logo
          </a>
          <a className="hover:text-foreground" href="#cor">
            Cor
          </a>
          <a className="hover:text-foreground" href="#tipografia">
            Tipografia
          </a>
          <a className="hover:text-foreground" href="#elementos">
            Interface
          </a>
          <a className="hover:text-foreground" href="#voz">
            Voz
          </a>
        </nav>
        <a
          href="#downloads"
          className={cn(
            buttonVariants({ variant: 'outline', size: 'sm' }),
            'hidden sm:inline-flex',
          )}
        >
          <Download data-icon="inline-start" />
          Baixar logos
        </a>
      </header>

      <section className="relative isolate grid min-h-[26rem] overflow-hidden rounded-[2rem] bg-primary px-6 py-8 text-primary-foreground sm:px-10 sm:py-12 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-end lg:px-14 lg:py-14">
        <div className="relative z-10 max-w-2xl self-end">
          <p className="text-[0.6875rem] font-semibold tracking-[0.18em] text-primary-foreground/60 uppercase">
            Identidade visual
          </p>
          <h1 className="font-heading mt-4 text-5xl leading-[0.94] font-medium tracking-[-0.055em] sm:text-6xl lg:text-7xl">
            Clareza para decidir.
          </h1>
          <p className="mt-6 max-w-xl text-base leading-relaxed text-primary-foreground/70 sm:text-lg">
            Informação financeira densa, organizada com calma.
          </p>
        </div>
        <SpendleLogo
          variant="brandmark"
          className="pointer-events-none absolute -right-14 -bottom-16 size-72 text-primary-foreground/10 sm:size-96 lg:static lg:ml-auto lg:size-72 lg:self-center lg:text-primary-foreground/15"
        />
      </section>

      <BrandSection id="logo" eyebrow="Logo" title="Marca e assinatura">
        <div className="grid gap-px overflow-hidden rounded-2xl border bg-border sm:grid-cols-2">
          <figure className="flex min-h-36 flex-col items-center justify-center gap-4 bg-primary p-4 text-primary-foreground sm:min-h-48 sm:gap-5 sm:p-6">
            <SpendleLogo variant="brandmark" className="size-20" />
            <figcaption className="text-[0.625rem] tracking-[0.14em] text-primary-foreground/60 uppercase">
              Brandmark · fundo azul
            </figcaption>
          </figure>
          <figure className="flex min-h-36 flex-col items-center justify-center gap-4 bg-card p-4 text-primary sm:min-h-48 sm:gap-5 sm:p-6">
            <SpendleLogo variant="brandmark" className="size-20" />
            <figcaption className="text-[0.625rem] tracking-[0.14em] text-muted-foreground uppercase">
              Brandmark · fundo claro
            </figcaption>
          </figure>
          <figure className="flex min-h-36 flex-col items-center justify-center gap-4 bg-primary p-4 text-primary-foreground sm:min-h-48 sm:gap-5 sm:p-6">
            <SpendleLogo variant="wordmark" className="h-16 w-52 max-w-full" />
            <figcaption className="text-[0.625rem] tracking-[0.14em] text-primary-foreground/60 uppercase">
              Wordmark · fundo azul
            </figcaption>
          </figure>
          <figure className="flex min-h-36 flex-col items-center justify-center gap-4 bg-card p-4 text-primary sm:min-h-48 sm:gap-5 sm:p-6">
            <SpendleLogo variant="wordmark" className="h-16 w-52 max-w-full" />
            <figcaption className="text-[0.625rem] tracking-[0.14em] text-muted-foreground uppercase">
              Wordmark · fundo claro
            </figcaption>
          </figure>
        </div>

        <div className="mt-7">
          <h3 className="text-sm font-semibold">Lockup horizontal</h3>
          <div className="mt-3 flex min-h-40 items-center justify-center gap-3 rounded-2xl bg-primary p-6 text-primary-foreground">
            <SpendleLogo variant="brandmark" className="size-12" />
            <SpendleLogo variant="wordmark" className="h-12 w-40" />
          </div>
        </div>

        <dl className="mt-7 grid gap-px overflow-hidden rounded-2xl border bg-border sm:grid-cols-2">
          {logoRules.map(([term, detail]) => (
            <div key={term} className="bg-card p-4 sm:p-5">
              <dt className="text-sm font-semibold">{term}</dt>
              <dd className="mt-1 text-sm text-muted-foreground">{detail}</dd>
            </div>
          ))}
        </dl>

        <div id="downloads" className="mt-7 scroll-mt-6">
          <h3 className="text-sm font-semibold">Downloads</h3>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl border bg-card p-4">
              <div className="flex h-28 items-center justify-center rounded-xl bg-muted text-primary">
                <SpendleLogo variant="brandmark" className="size-16" />
              </div>
              <div className="mt-4">
                <p className="text-sm font-semibold">Brandmark</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <DownloadLink href="/spendle-brandmark.svg">SVG</DownloadLink>
                  <DownloadLink href="/brand/spendle-brandmark-light.png">
                    PNG claro
                  </DownloadLink>
                  <DownloadLink href="/brand/spendle-brandmark-dark.png">
                    PNG escuro
                  </DownloadLink>
                </div>
              </div>
            </div>
            <div className="rounded-2xl border bg-card p-4">
              <div className="flex h-28 items-center justify-center rounded-xl bg-muted text-primary">
                <SpendleLogo variant="wordmark" className="h-14 w-44" />
              </div>
              <div className="mt-4">
                <p className="text-sm font-semibold">Wordmark</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <DownloadLink href="/spendle-wordmark.svg">SVG</DownloadLink>
                  <DownloadLink href="/brand/spendle-wordmark-light.png">
                    PNG claro
                  </DownloadLink>
                  <DownloadLink href="/brand/spendle-wordmark-dark.png">
                    PNG escuro
                  </DownloadLink>
                </div>
              </div>
            </div>
          </div>
        </div>
      </BrandSection>

      <BrandSection id="cor" eyebrow="Cor" title="Paleta">
        <ul className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border bg-border lg:grid-cols-3">
          {colors.map(([name, value, token]) => (
            <li key={name} className="bg-card p-4">
              <span
                aria-label={`Amostra da cor ${name}`}
                className="block h-12 rounded-lg border"
                style={{ backgroundColor: value }}
              />
              <p className="mt-3 flex items-baseline justify-between gap-3 text-sm">
                <span className="font-semibold">{name}</span>
                <code className="text-xs text-muted-foreground">{value}</code>
              </p>
              <code className="mt-1 block text-[0.6875rem] text-muted-foreground">
                {token}
              </code>
            </li>
          ))}
        </ul>

        <div className="mt-7">
          <h3 className="text-sm font-semibold">Cristal</h3>
          <div className="brand-atmosphere mt-3 h-32 rounded-2xl border border-white/70" />
        </div>
      </BrandSection>

      <BrandSection id="tipografia" eyebrow="Tipografia" title="Geist Variable">
        <div className="divide-y overflow-hidden rounded-2xl border bg-card">
          <div className="grid gap-3 p-5 sm:grid-cols-[10rem_1fr] sm:items-baseline">
            <p className="text-xs text-muted-foreground">Display · 500</p>
            <p className="text-4xl font-medium tracking-[-0.04em] sm:text-5xl">
              Seu mês, sem ruído
            </p>
          </div>
          <div className="grid gap-3 p-5 sm:grid-cols-[10rem_1fr] sm:items-baseline">
            <p className="text-xs text-muted-foreground">Título · 600</p>
            <p className="text-2xl font-semibold tracking-tight">
              Planejamento de setembro
            </p>
          </div>
          <div className="grid gap-3 p-5 sm:grid-cols-[10rem_1fr] sm:items-baseline">
            <p className="text-xs text-muted-foreground">Corpo · 400</p>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Quanto entrou, quanto saiu e o que já está comprometido.
            </p>
          </div>
          <div className="grid gap-3 p-5 sm:grid-cols-[10rem_1fr] sm:items-baseline">
            <p className="text-xs text-muted-foreground">Números · tabular</p>
            <p className="text-3xl font-semibold tracking-tight tabular-nums">
              R$ 12.480,35
            </p>
          </div>
        </div>
      </BrandSection>

      <BrandSection id="elementos" eyebrow="Elementos" title="Interface">
        <div className="grid gap-px overflow-hidden rounded-2xl border bg-border sm:grid-cols-2">
          <div className="bg-card p-5">
            <p className="text-xs font-medium text-muted-foreground uppercase">
              Ações
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              <span className={buttonVariants()}>Importar extrato</span>
              <span className={buttonVariants({ variant: 'outline' })}>
                Revisar depois
              </span>
            </div>
          </div>
          <div className="bg-card p-5">
            <p className="text-xs font-medium text-muted-foreground uppercase">
              Estados
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              <Badge variant="success">Conciliado</Badge>
              <Badge variant="warning">Revisar</Badge>
              <Badge variant="destructive">Diferença</Badge>
            </div>
          </div>
          <div className="bg-card p-5">
            <p className="text-xs font-medium text-muted-foreground uppercase">
              Análise contextual
            </p>
            <p className="mt-5 flex gap-2 text-sm leading-relaxed">
              <Sparkles className="mt-0.5 size-4 shrink-0 text-primary" />
              As despesas fixas ocupam 48% da renda prevista.
            </p>
          </div>
          <div className="bg-card p-5">
            <p className="text-xs font-medium text-muted-foreground uppercase">
              Ícones
            </p>
            <div className="mt-5 flex items-center gap-5 text-muted-foreground">
              <Check className="size-5 text-success" />
              <Sparkles className="size-5 text-primary" />
              <X className="size-5 text-destructive" />
            </div>
          </div>
        </div>
      </BrandSection>

      <BrandSection id="voz" eyebrow="Voz" title="Como escrevemos">
        <div className="grid gap-7 text-sm leading-relaxed sm:grid-cols-2">
          <div>
            <h3 className="font-semibold">Somos</h3>
            <p className="mt-2 text-muted-foreground">
              Calmos, diretos e concretos. Falamos em valores, períodos e
              próximos passos.
            </p>
          </div>
          <div>
            <h3 className="font-semibold">Nunca</h3>
            <p className="mt-2 text-muted-foreground">
              Alarmismo, julgamento, promessa vazia ou jargão bancário sem
              explicação.
            </p>
          </div>
        </div>
      </BrandSection>
    </div>
  )
}
