import type { findInstitutionServices } from '../../services/institutionAccessService.ts';

export type InstitutionService = NonNullable<Awaited<ReturnType<typeof findInstitutionServices>>>['services'][number];

/** Group by the catalogue's platform identity, never by a library package or a display label. */
export function groupInstitutionServices(services: readonly InstitutionService[]) {
  const groups = new Map<string, { id: string; name: string; representative: InstitutionService; services: InstitutionService[] }>();
  for (const service of services) {
    const id = service.platformId || service.id;
    const group = groups.get(id);
    if (group) {
      group.services.push(service);
      if (service.id === id) {
        group.name = service.name;
        group.representative = service;
      }
    } else {
      groups.set(id, {
        id,
        name: service.platformId ? service.publisher || service.name : service.name,
        representative: service,
        services: [service],
      });
    }
  }
  return [...groups.values()];
}
