import type { Metadata } from "next";
import { PersonaPage } from "../persona-page";
import { getPersona, personaMetadata } from "../personas";

const persona = getPersona("developers");

export const metadata: Metadata = personaMetadata(persona);

export default function DevelopersPage() {
  return <PersonaPage persona={persona} />;
}
