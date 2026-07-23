interface DemoSmsPreviewProps {
  to: string;
  body: string;
  status: 'simulated' | 'sent' | 'failed';
}

export function DemoSmsPreview({ to, body, status }: DemoSmsPreviewProps) {
  return (
    <div className="rounded-lg border border-primary/40 bg-primary/5 p-4">
      <div className="flex items-center gap-2 text-xs uppercase tracking-widest text-primary font-bold mb-3">
        <span className="inline-block h-2 w-2 rounded-full bg-primary animate-pulse" />
        {status === 'simulated' ? 'Demo SMS — would be sent in Twilio mode' : status === 'sent' ? 'SMS sent via Twilio ✓' : 'SMS failed'}
      </div>
      <div className="mx-auto max-w-xs rounded-2xl border border-border bg-background shadow-md overflow-hidden">
        <div className="bg-secondary px-4 py-2 text-center text-xs text-muted-foreground font-semibold tracking-wide">
          Messages · {to}
        </div>
        <div className="p-4">
          <div className="ml-auto max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-4 py-3 text-sm text-primary-foreground shadow-sm">
            {body}
          </div>
          <div className="mt-1 text-right text-[10px] text-muted-foreground">Delivered</div>
        </div>
      </div>
    </div>
  );
}