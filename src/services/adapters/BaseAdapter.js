/**
 * Base interface for provider adapters.
 * All adapters must follow this shape so PaperBuilder and the recommendation engine
 * can remain provider-agnostic.
 */
export class BaseAdapter {
  constructor(name) {
    this.name = name;
  }

  /**
   * Busca papers dado un string de consulta.
   * @param {string} query - Search term.
   * @param {number} page - Current page.
   * @param {object} filters - Additional filters.
   * @returns {Promise<{papers: Array, total: number}>}
   */
  async search() {
    throw new Error('search() debe ser implementado por la clase hija');
  }

  /**
   * Obtiene detalles de un paper dado su ID nativo o DOI.
   * @param {string} id - El identificador.
   * @returns {Promise<Object>}
   */
  async getDetails() {
    throw new Error('getDetails() debe ser implementado por la clase hija');
  }

  /**
   * Maps a provider paper to the standard intermediate format.
   * Formato intermedio esperado:
   * {
   *   id: string,
   *   doi: string | null,
   *   title: string,
   *   abstract: string,
   *   authors: Array<{name: string, id: string | null, affiliation: string | null}>,
   *   publishedDate: string,
   *   year: number,
   *   sourceName: string, // Nombre de la revista o conferencia
   *   sourceType: 'journal' | 'conference' | 'repository' | 'other',
   *   publicationStatus: 'published' | 'preprint',
   *   isOpenAccess: boolean,
   *   pdfUrl: string | null,
   *   landingPageUrl: string | null,
   *   citationsCount: number,
   *   provider: string, // ej: 'semanticscholar', 'arxiv'
   *   raw: Object // Original provider object
   * }
   */
  mapToStandard() {
    throw new Error('mapToStandard() debe ser implementado por la clase hija');
  }
}
