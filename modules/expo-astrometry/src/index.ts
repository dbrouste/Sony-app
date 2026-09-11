import { NativeModule, requireNativeModule } from 'expo';

export type AstrometryIndexStatus = {
  number: number;
  fileName: string;
  sizeBytes: number;
  installed: boolean;
  valid: boolean;
  required: boolean;
};

export type AstrometryCatalogStatus = {
  directory: string;
  focalLength: number;
  ready: boolean;
  installedBytes: number;
  requiredBytes: number;
  indexes: AstrometryIndexStatus[];
};

export type AstrometrySolveResult = {
  solved: boolean;
  ra: number;
  dec: number;
  crpixX: number;
  crpixY: number;
  cd11: number;
  cd12: number;
  cd21: number;
  cd22: number;
  pixelScale: number;
  rotation: number;
  logOdds: number;
  starCount: number;
  imageWidth: number;
  imageHeight: number;
};

export type CatalogProgress = {
  fileName: string;
  fileBytes: number;
  fileSizeBytes: number;
  totalBytes: number;
  totalSizeBytes: number;
};

type AstrometryEvents = {
  onCatalogProgress: (progress: CatalogProgress) => void;
};

declare class ExpoAstrometryNativeModule extends NativeModule<AstrometryEvents> {
  getCatalogStatus(focalLength: number): AstrometryCatalogStatus;
  downloadCatalog(focalLength: number): Promise<AstrometryCatalogStatus>;
  cancelCatalogDownload(): { ok: boolean; active: boolean };
  deleteCatalog(): AstrometryCatalogStatus;
  importIndex(uri: string): Promise<AstrometryCatalogStatus>;
  solveImage(uri: string, focalLength: number): Promise<AstrometrySolveResult>;
}

export default requireNativeModule<ExpoAstrometryNativeModule>('ExpoAstrometry');
