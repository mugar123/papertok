import type { Project } from '../../services/open-aire-service.ts';
import { getProjectDisplayName } from '../../utils/entity-metadata.ts';

/**
 * The funder a project's OpenAIRE lookups are asked with. A grant code alone
 * is not unique across funders (code 100010 answers for NHMRC, SNSF and
 * UKRI alike), so the route's funder comes first, then the one the entity
 * already carries.
 */
export function projectLookupFunder(routeFunder: string | null, entityFunder?: string) {
  return routeFunder || entityFunder || '';
}

/**
 * The project entity once OpenAIRE's details lookup has answered (`details`)
 * or failed (`null`).
 *
 * `entity.id` stays the route id: it is one of `entityPapersRequestKey`'s
 * inputs, so renaming it to the grant code OpenAIRE returns would cancel the
 * papers request already in flight. That code goes in `entity.code`.
 *
 * A failed lookup keeps the route's name or none at all. `display_name` is
 * what the follow identity is built from, and one stand-in shared by every
 * nameless project made them all the same follow: following one deleted
 * another's document. The hero falls back to the page's own label where it
 * renders the title. When the route id is an OpenAIRE id it is kept for the
 * empty state's link out.
 */
export function projectEntityFromLookup({ routeId, name, funder, details }: {
  routeId: string;
  name: string;
  funder: string;
  details: Project | null;
}) {
  if (details) {
    return {
      id: routeId,
      code: details.id || routeId,
      openaireId: details.openaireId,
      display_name: getProjectDisplayName(details),
      type: 'project',
      funder: details.funder,
      fundingStream: details.fundingStream,
      summary: details.summary,
      startDate: details.startDate,
      endDate: details.endDate,
      budget: details.budget,
      fundedAmount: details.fundedAmount,
      currency: details.currency,
      callIdentifier: details.callIdentifier,
      subjects: details.subjects,
      participants: details.participants,
      measures: details.measures,
      openAccess: details.openAccess,
      websiteUrl: details.websiteUrl,
    };
  }
  return {
    id: routeId,
    openaireId: routeId.includes('::') ? routeId : undefined,
    display_name: name,
    type: 'project',
    funder,
  };
}
