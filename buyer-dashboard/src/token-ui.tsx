import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode, TableHTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from 'react'

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ')
}

export function Button({
  variant = 'default',
  size = 'default',
  className,
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'secondary' | 'outline' | 'ghost' | 'destructive'
  size?: 'default' | 'sm' | 'lg'
}) {
  return (
    <button
      type={type}
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={className}
      {...props}
    />
  )
}

export function Card({
  className,
  size = 'default',
  ...props
}: HTMLAttributes<HTMLDivElement> & { size?: 'default' | 'sm' }) {
  return <section data-slot="card" data-size={size} className={className} {...props} />
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="card-header" className={className} {...props} />
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 data-slot="card-title" className={className} {...props} />
}

export function CardDescription({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="card-description" className={className} {...props} />
}

export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="card-content" className={className} {...props} />
}

export function Badge({
  variant = 'neutral',
  className,
  children,
  ...props
}: HTMLAttributes<HTMLSpanElement> & {
  variant?: 'primary' | 'success' | 'warning' | 'danger' | 'neutral' | 'outline'
  children: ReactNode
}) {
  return (
    <span data-slot="badge" data-variant={variant} className={className} {...props}>
      {children}
    </span>
  )
}

export function Table({ className, ...props }: TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div data-slot="table-container">
      <table data-slot="table" className={className} {...props} />
    </div>
  )
}

export function TableHeader({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead data-slot="table-header" className={className} {...props} />
}

export function TableBody({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody data-slot="table-body" className={className} {...props} />
}

export function TableRow({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return <tr data-slot="table-row" className={className} {...props} />
}

export function TableHead({ className, ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
  return <th data-slot="table-head" className={className} {...props} />
}

export function TableCell({ className, ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td data-slot="table-cell" className={className} {...props} />
}

export function StatusBadge({ status }: { status: string }) {
  const variant =
    status === 'active' || status === 'trusted'
      ? 'success'
      : status === 'suspicious' || status === 'revoked'
        ? 'danger'
        : status === 'degraded' || status === 'exhausted'
          ? 'warning'
          : 'neutral'

  return <Badge variant={variant}>{status}</Badge>
}

export function PanelTitle({
  eyebrow,
  title,
  action,
}: {
  eyebrow?: string
  title: string
  action?: ReactNode
}) {
  return (
    <CardHeader className={cx(action ? 'with-action' : undefined)}>
      <div>
        {eyebrow ? <CardDescription>{eyebrow}</CardDescription> : null}
        <CardTitle>{title}</CardTitle>
      </div>
      {action ? <div data-slot="card-action">{action}</div> : null}
    </CardHeader>
  )
}
