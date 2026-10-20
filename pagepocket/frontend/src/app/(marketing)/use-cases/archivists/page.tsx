import type { Metadata } from "next";
import { PersonaPage } from "../persona-page";
import { getPersona, personaMetadata } from "../personas";

const persona = getPersona("archivists");

export const metadata: Metadata = personaMetadata(persona);

export default function ArchivistsPage() {
  return <PersonaPage persona={persona} />;
}
