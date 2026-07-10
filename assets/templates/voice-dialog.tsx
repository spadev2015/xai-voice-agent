'use client'

/**
 * Minimal call UI: a trigger button, a dialog with a call orb, live
 * transcript, mute toggle, and end-call. Uses shadcn/ui — if your app doesn't
 * have it, swap Dialog/Button/ScrollArea for your own primitives; the state
 * wiring is the part that matters.
 *
 * Key detail: closing the dialog calls stop(), so users can never leave a
 * call (and the mic) running behind a closed dialog.
 */

import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Loader2, Mic, MicOff, Phone, PhoneOff } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useVoiceAgent, type VoiceAgentState } from './use-voice-agent'

const STATUS_LABELS: Record<VoiceAgentState, string> = {
  idle: 'Start a voice conversation',
  connecting: 'Connecting…',
  listening: 'Listening',
  speaking: 'Assistant is speaking',
  tool: 'Working on it…',
  ended: 'Call ended',
  error: 'Something went wrong',
}

const ACTIVE_STATES: VoiceAgentState[] = ['connecting', 'listening', 'speaking', 'tool']

export function VoiceAssistantDialog() {
  const [open, setOpen] = useState(false)
  const { state, transcript, start, stop, muted, toggleMute, error } = useVoiceAgent()
  const transcriptEndRef = useRef<HTMLDivElement>(null)

  const isActive = ACTIVE_STATES.includes(state)

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [transcript])

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen)
    if (!nextOpen) stop()
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" className="w-full h-10">
          <Phone className="mr-2 h-4 w-4" />
          Voice Assistant
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Voice Assistant</DialogTitle>
          <DialogDescription>
            Talk to the assistant — out loud.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center gap-4 py-4">
          {/* Call orb — the visual state of the call */}
          <div
            className={cn(
              'flex h-20 w-20 items-center justify-center rounded-full transition-all duration-300',
              state === 'speaking'
                ? 'bg-primary text-primary-foreground scale-105'
                : 'bg-primary/10 text-primary',
              state === 'listening' && 'ring-4 ring-primary/30 animate-pulse',
              state === 'error' && 'bg-destructive/10 text-destructive'
            )}
          >
            {state === 'connecting' || state === 'tool' ? (
              <Loader2 className="h-8 w-8 animate-spin" />
            ) : muted && isActive ? (
              <MicOff className="h-8 w-8" />
            ) : (
              <Mic className="h-8 w-8" />
            )}
          </div>

          <p
            className={cn(
              'text-sm',
              state === 'error' ? 'text-destructive' : 'text-muted-foreground'
            )}
            aria-live="polite"
          >
            {state === 'error' && error ? error : STATUS_LABELS[state]}
          </p>

          {transcript.length > 0 && (
            <ScrollArea className="h-40 w-full rounded-md border border-border p-3">
              <div className="space-y-2">
                {transcript.map((entry, i) => (
                  <p key={i} className="text-sm leading-snug">
                    <span
                      className={cn(
                        'font-medium',
                        entry.role === 'assistant' ? 'text-primary' : 'text-muted-foreground'
                      )}
                    >
                      {entry.role === 'assistant' ? 'Assistant: ' : 'You: '}
                    </span>
                    <span className="text-foreground">{entry.text}</span>
                  </p>
                ))}
                <div ref={transcriptEndRef} />
              </div>
            </ScrollArea>
          )}

          <div className="flex items-center gap-3">
            {isActive ? (
              <>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={toggleMute}
                  aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}
                >
                  {muted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                </Button>
                <Button variant="destructive" onClick={stop}>
                  <PhoneOff className="mr-2 h-4 w-4" />
                  End call
                </Button>
              </>
            ) : (
              <Button onClick={start}>
                <Phone className="mr-2 h-4 w-4" />
                {state === 'ended' || state === 'error' ? 'Call again' : 'Start call'}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
