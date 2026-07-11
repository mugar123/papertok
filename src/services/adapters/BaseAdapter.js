/**
 * Interfaz base para los adaptadores de proveedores.
 * Todos los adaptadores deben seguir este formato para que el PaperBuilder y el Motor de Recomendación
 * puedan funcionar de manera agnóstica al proveedor.
 */
export class BaseAdapter {
  constructor(name) {
    this.name = name;
  }

  /**
   * Busca papers dado un string de consulta.
   * @param {string} query - El término de búsqueda.
   * @param {number} page - La página actual.
   * @param {object} filters - Filtros adicionales.
   * @returns {Promise<{papers: Array, total: number}>}
   */
  async search(query, page = 1, filters = {}) {
    throw new Error('search() debe ser implementado por la clase hija');
  }

  /**
   * Obtiene detalles de un paper dado su ID nativo o DOI.
   * @param {string} id - El identificador.
   * @returns {Promise<Object>}
   */
  async getDetails(id) {
    throw new Error('getDetails() debe ser implementado por la clase hija');
  }

  /**
   * Mapea un paper devuelto por el proveedor al formato estándar intermedio.
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
   *   provider: string, // ej: 'elsevier', 'arxiv'
   *   raw: Object // El objeto original del proveedor
   * }
   */
  mapToStandard(rawItem) {
    throw new Error('mapToStandard() debe ser implementado por la clase hija');
  }
}
