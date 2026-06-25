// CRUD helpers for merchant-managed glossary — brand names, SKUs, or phrases
// that should never be machine-translated (or need a fixed translation every time).
// These are passed into translateFields() as instructions for the AI provider.
import db from "../db.server";

export async function listGlossaryTerms(shop) {
  return db.glossaryTerm.findMany({ where: { shop }, orderBy: { sourceTerm: "asc" } });
}

export async function glossaryForLocale(shop, targetLocale) {
  return db.glossaryTerm.findMany({ where: { shop, targetLocale } });
}

export async function addGlossaryTerm(shop, { sourceTerm, targetLocale, targetTerm }) {
  return db.glossaryTerm.create({ data: { shop, sourceTerm, targetLocale, targetTerm } });
}

export async function deleteGlossaryTerm(shop, id) {
  return db.glossaryTerm.deleteMany({ where: { id, shop } });
}
