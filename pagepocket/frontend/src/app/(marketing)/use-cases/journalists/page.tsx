import type { Metadata } from "next";
import { PersonaPage } from "../persona-page";
import { getPersona, personaMetadata } from "../personas";

const persona = getPersona("journalists");

export const metadata: Metadata = personaMetadata(persona);

export default function JournalistsPage() {
  return <PersonaPage persona={persona} />;
}
