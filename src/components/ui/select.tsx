import * as React from 'react';
import * as SelectPrimitives from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useLanguageStore } from '../../store/languageStore';

const Select = SelectPrimitives.Root;
const SelectTrigger = React.forwardRef<
  React.ElementRef<typeof SelectPrimitives.Trigger>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitives.Trigger>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitives.Trigger
    ref={ref}
    className={cn(
      'flex h-10 w-full items-center justify-between rounded-md border border-gray-300 bg-white px-3 py-2 text-sm ring-offset-background placeholder:text-gray-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
      className
    )}
    {...props}
  >
    {children}
    <ChevronDown className="h-4 w-4 opacity-50" />
  </SelectPrimitives.Trigger>
));
SelectTrigger.displayName = SelectPrimitives.Trigger.displayName;

const SelectValue = SelectPrimitives.Value;
const SelectItem = React.forwardRef<
  React.ElementRef<typeof SelectPrimitives.Item>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitives.Item>
>(({ className, children, ...props }, ref) => {
  const { direction } = useLanguageStore();
  const isRtl = direction === 'rtl';
  const justifyContent = isRtl ? 'flex-row-reverse' : '';
  return (
    <SelectPrimitives.Item
      ref={ref}
      className={cn(
        'relative cursor-default select-none py-2 px-2 text-sm outline-none data-[disabled]:opacity-70 data-[state=checked]:bg-accent data-[state=checked]:text-accent-foreground flex items-center justify-start justify-items-start gap-1',
        justifyContent,
        className
      )}
      {...props}
    >
      <Check className="h-4 w-4" />
      {children}
    </SelectPrimitives.Item>
  )
});
SelectItem.displayName = SelectPrimitives.Item.displayName;

const SelectContent = React.forwardRef<
  React.ElementRef<typeof SelectPrimitives.Content>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitives.Content>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitives.Content
    ref={ref}
    className={cn(
      'relative z-50 min-w-[8rem] overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1',
      className
    )}
    {...props}
  >
    <SelectPrimitives.Viewport className="w-full outline-none p-1">
      {children}
    </SelectPrimitives.Viewport>
  </SelectPrimitives.Content>
));
SelectContent.displayName = SelectPrimitives.Content.displayName;

export { Select, SelectTrigger, SelectValue, SelectItem, SelectContent };