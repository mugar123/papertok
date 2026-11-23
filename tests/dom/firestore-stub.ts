export * from 'firebase/firestore/lite';

export function doc(db: object, ...path: string[]) {
  return { db, path: path.join('/') };
}

export const collection = doc;

export function query(ref: ReturnType<typeof doc>) {
  return ref;
}

export async function getDocs() {
  return { empty: true, metadata: { fromCache: false }, forEach() {} };
}

export async function getDoc() {
  return { exists: () => false, metadata: { fromCache: false, hasPendingWrites: false } };
}

export const getDocFromCache = getDoc;
