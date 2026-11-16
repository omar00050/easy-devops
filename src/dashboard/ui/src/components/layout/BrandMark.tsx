import { cn } from '../../lib/cn';

/**
 * Project logo from src/dashboard/public/img. Small sizes use the cropped EZ
 * mark (the DEVOPS wordmark in the full lockup is illegible below ~100px).
 * Both theme variants are in the DOM; CSS shows the one matching data-theme.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex shrink-0 items-center', className)} aria-hidden="true">
      <img src="/brand/mark-dark.png" alt="" className="brand-logo-dark h-full w-auto" />
      <img src="/brand/mark-light.png" alt="" className="brand-logo-light h-full w-auto" />
    </span>
  );
}
