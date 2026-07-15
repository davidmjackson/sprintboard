import type { ReactNode } from 'react'

import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card'

/**
 * The shell shared by the signup and login screens: a centered card on a full-height
 * background. Both auth routes render through this so they stay visually identical
 * and only their form differs.
 */
export function AuthLayout({
  title,
  description,
  children,
  footer,
}: {
  title: string
  description: string
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-6 p-8">
      <Card className="w-full max-w-sm">
        <CardHeader>
          {/* A real <h1>, not shadcn's CardTitle (a div): the auth screens should
              expose a heading to assistive tech and the document outline. */}
          <h1 className="font-heading text-xl leading-snug font-medium">{title}</h1>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">{children}</CardContent>
      </Card>
      {footer ? <p className="text-muted-foreground text-sm">{footer}</p> : null}
    </main>
  )
}
