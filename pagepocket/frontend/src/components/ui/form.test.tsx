import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { Form, FormField } from "@/components/ui/form";
import { Input } from "@/components/ui/input";

function TestForm({
  onSubmit,
}: {
  onSubmit: (data: { email: string }) => void;
}) {
  const schema = z.object({
    email: z.string().email("Invalid email"),
  });

  const methods = useForm({
    resolver: zodResolver(schema),
    defaultValues: { email: "" },
  });

  return (
    <Form methods={methods} onSubmit={onSubmit}>
      <FormField
        name="email"
        label="Email"
        children={({ field }) => <Input id="email" {...field} />}
      />
      <button type="submit">Submit</button>
    </Form>
  );
}

describe("Form", () => {
  it("renders with label and input", () => {
    render(<TestForm onSubmit={vi.fn()} />);
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
  });

  it("shows validation error on invalid submit", async () => {
    const user = userEvent.setup();
    render(<TestForm onSubmit={vi.fn()} />);

    await user.click(screen.getByText("Submit"));
    expect(await screen.findByText("Invalid email")).toBeInTheDocument();
  });

  it("calls onSubmit with valid data", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<TestForm onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText("Email"), "test@example.com");
    await user.click(screen.getByText("Submit"));

    expect(onSubmit).toHaveBeenCalledWith(
      { email: "test@example.com" },
      expect.anything(),
    );
  });
});
