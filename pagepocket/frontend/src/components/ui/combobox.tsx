"use client"

import * as React from "react"
import { CheckIcon, ChevronsUpDown } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

type ComboboxOption = {
  value: string
  label: string
}

function Combobox({
  options,
  value,
  onValueChange,
  placeholder = "Select an option...",
  emptyMessage = "No results found.",
  className,
}: {
  options: ComboboxOption[]
  value?: string
  onValueChange?: (value: string) => void
  placeholder?: string
  emptyMessage?: string
  className?: string
}) {
  const [open, setOpen] = React.useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className={cn("w-full justify-between", className)}
          />
        }
      >
        {value
          ? options.find((o) => o.value === value)?.label
          : placeholder}
        <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
      </PopoverTrigger>
      <PopoverContent className="w-[--popover-width] p-0">
        <Command>
          <CommandInput placeholder={placeholder} />
          <CommandList>
            <CommandEmpty>{emptyMessage}</CommandEmpty>
            <CommandGroup>
              {options.map((option) => (
                <CommandItem
                  key={option.value}
                  value={option.value}
                  onSelect={(current) => {
                    onValueChange?.(current === value ? "" : current)
                    setOpen(false)
                  }}
                >
                  {option.label}
                  <CheckIcon
                    className={cn(
                      "ml-auto size-4",
                      value === option.value ? "opacity-100" : "opacity-0",
                    )}
                  />
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

export { Combobox, type ComboboxOption }
