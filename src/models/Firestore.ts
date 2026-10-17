export type FirestoreValue =
  | { nullValue: null }
  | { booleanValue: boolean }
  | { integerValue: string }
  | { doubleValue: number }
  | { stringValue: string }
  | { timestampValue: string }
  | { arrayValue: { values?: FirestoreValue[] } }
  | { mapValue: { fields?: Record<string, FirestoreValue> } }
  | { referenceValue: string }
  | { geoPointValue: { latitude: number; longitude: number } }
  | { bytesValue: string };

export type FirestoreDataValue = null | boolean | number | string | Date | FirestoreDataValue[] | FirestoreData;
export interface FirestoreData { [field: string]: FirestoreDataValue }
