'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SessionProvider } from 'next-auth/react'
import { useState, type ReactNode } from 'react'
import { Toaster as SonnerToaster } from 'sonner'

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
          },
        },
      }),
  )
  return (
    <QueryClientProvider client={client}>
      <SessionProvider>
        {children}
        <SonnerToaster position="bottom-right" richColors closeButton />
      </SessionProvider>
    </QueryClientProvider>
  )
}
