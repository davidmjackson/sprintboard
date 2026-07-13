import { useState } from 'react'
import { Button } from '@/components/ui/button'

/**
 * Placeholder shell for S1.1. Proves the stack is wired end to end: Tailwind
 * utilities, a shadcn/ui component, and React state. The real app shell arrives
 * with S3.3.
 */
export default function App() {
  const [count, setCount] = useState(0)

  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-6 p-8">
      <div className="space-y-2 text-center">
        <h1 className="text-3xl font-semibold tracking-tight">Sprintboard</h1>
        <p className="text-muted-foreground text-sm">
          AI-native Scrum delivery board. Phase 1 scaffold.
        </p>
      </div>

      <Button onClick={() => setCount((c) => c + 1)}>Clicked {count} times</Button>
    </main>
  )
}
