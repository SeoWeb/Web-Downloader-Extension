"use client";

import type { ComponentProps, ReactNode } from "react";
import type { FieldValues, Path, UseFormReturn } from "react-hook-form";
import {
  Controller,
  FormProvider,
  useFormContext,
} from "react-hook-form";
import { cn } from "@/lib/utils";
import { Label } from "@/components/ui/label";

type FormProps<T extends FieldValues> = {
  children: ReactNode;
  methods: UseFormReturn<T>;
  onSubmit: (data: T) => void | Promise<void>;
  className?: string;
};

export function Form<T extends FieldValues>({
  children,
  methods,
  onSubmit,
  className,
}: FormProps<T>) {
  return (
    <FormProvider {...methods}>
      <form
        onSubmit={methods.handleSubmit(onSubmit)}
        className={cn("space-y-4", className)}
      >
        {children}
      </form>
    </FormProvider>
  );
}

type FormFieldProps<T extends FieldValues> = {
  name: Path<T>;
  label?: string;
  children: ComponentProps<typeof Controller<T>>["render"];
  description?: string;
};

export function FormField<T extends FieldValues>({
  name,
  label,
  children,
  description,
}: FormFieldProps<T>) {
  const { control } = useFormContext<T>();

  return (
    <Controller
      control={control}
      name={name}
      render={(renderProps) => (
        <div className="space-y-2">
          {label && <Label htmlFor={name}>{label}</Label>}
          {children(renderProps)}
          {description && !renderProps.fieldState.error && (
            <p className="text-muted-foreground text-sm">{description}</p>
          )}
          {renderProps.fieldState.error && (
            <p className="text-destructive text-sm">{renderProps.fieldState.error.message}</p>
          )}
        </div>
      )}
    />
  );
}

export function FormError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="text-destructive text-sm">{message}</p>;
}
