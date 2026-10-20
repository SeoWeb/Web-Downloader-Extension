import type { Metadata } from "next";
import { PersonaPage } from "../persona-page";
import { getPersona, personaMetadata } from "../personas";

const persona = getPersona("researchers");

export const metadata: Metadata = personaMetadata(persona);

export default function ResearchersPage() {
  return <PersonaPage persona={persona} />;
}
