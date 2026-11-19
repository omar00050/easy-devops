import { Braces, Globe, Server, Terminal } from 'lucide-react';
import type { DeployRuntime } from '../../lib/types';
import { cn } from '../../lib/cn';
import { Badge } from '../ui/Badge';

type RuntimeId = DeployRuntime | 'python' | 'go' | 'static';

interface RuntimeOption {
  id: RuntimeId;
  name: string;
  description: string;
  icon: typeof Braces;
}

const RUNTIMES: RuntimeOption[] = [
  {
    id: 'node',
    name: 'Node.js',
    description: 'JavaScript and TypeScript: Next.js, NestJS, Express, Fastify, Nuxt.',
    icon: Braces,
  },
  {
    id: 'python',
    name: 'Python',
    description: 'Django, FastAPI, Flask.',
    icon: Terminal,
  },
  {
    id: 'go',
    name: 'Go',
    description: 'A compiled Go binary.',
    icon: Server,
  },
  {
    id: 'static',
    name: 'Static site',
    description: 'Files served as they are, with no process.',
    icon: Globe,
  },
];

/**
 * The runtime cards in the app form. Only Node.js is selectable; the others
 * stay visible, disabled, so the plan is obvious rather than a missing field.
 */
export function RuntimeCards({
  value,
  onChange,
}: {
  value: DeployRuntime;
  onChange: (runtime: DeployRuntime) => void;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {RUNTIMES.map((option) => {
        const available = option.id === 'node';
        const selected = option.id === value;
        const Icon = option.icon;
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={selected}
            disabled={!available}
            onClick={() => available && onChange(option.id as DeployRuntime)}
            className={cn(
              'flex items-start gap-3 rounded-lg border px-3 py-3 text-left transition-colors duration-[var(--ez-motion-fast)]',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
              selected
                ? 'border-accent bg-accent-soft'
                : 'border-line bg-raised/40',
              available && !selected && 'hover:border-line-strong hover:bg-raised',
              !available && 'cursor-not-allowed opacity-60'
            )}
          >
            <span
              className={cn(
                'mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-md border',
                selected ? 'border-accent/40 bg-canvas text-accent-text' : 'border-line bg-canvas text-muted'
              )}
            >
              <Icon className="size-4" aria-hidden="true" />
            </span>
            <span className="min-w-0">
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-ink">{option.name}</span>
                {selected && <Badge tone="accent">Selected</Badge>}
                {!available && <Badge tone="neutral">Coming soon</Badge>}
              </span>
              <span className="mt-0.5 block text-2xs text-muted">{option.description}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
