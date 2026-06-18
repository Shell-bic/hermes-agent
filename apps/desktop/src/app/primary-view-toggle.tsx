import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { cn } from '@/lib/utils'

export type PrimaryView = 'chat' | 'dsl'

interface PrimaryViewToggleProps {
  className?: string
  onChange: (view: PrimaryView) => void
  value: PrimaryView
}

const OPTIONS: { icon: string; label: string; value: PrimaryView }[] = [
  { icon: 'comment-discussion', label: 'Chat', value: 'chat' },
  { icon: 'layout', label: 'DSL', value: 'dsl' }
]

export function PrimaryViewToggle({ className, onChange, value }: PrimaryViewToggleProps) {
  return (
    <div
      aria-label="Primary view"
      className={cn(
        'pointer-events-auto flex shrink-0 items-center gap-0.5 rounded-[4px] border border-(--ui-stroke-tertiary) bg-(--ui-bg-quinary) p-0.5 [-webkit-app-region:no-drag]',
        className
      )}
      role="group"
    >
      {OPTIONS.map(option => (
        <Button
          aria-label={option.value === 'dsl' ? 'DSL Chat' : option.label}
          aria-pressed={value === option.value}
          className={cn(
            'h-5 min-w-10 gap-1 px-1.5 py-0 text-[0.6875rem] text-(--ui-text-tertiary) hover:text-(--ui-text-primary)',
            value === option.value && 'bg-(--ui-bg-secondary) text-(--ui-text-primary)'
          )}
          key={option.value}
          onClick={() => onChange(option.value)}
          size="xs"
          type="button"
          variant="ghost"
        >
          <Codicon name={option.icon} size="0.75rem" />
          <span>{option.label}</span>
        </Button>
      ))}
    </div>
  )
}
