import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Checkbox } from "./Checkbox";
import { CheckedState } from "@radix-ui/react-checkbox";
import {
  Download,
  Settings,
  Image as ImageIcon,
  Link as LinkIcon,
  FileCode,
  FileText,
  Layout,
  File,
  AlertTriangle,
  ChevronDown,
  ChevronUp
} from "lucide-react";
import cn from "classnames";

import {
  useFilterOptions,
  useDownloadOptions,
  useStorageStatus,
} from "../hooks/useFilterOptions";
import { StoragePermissionBanner } from "./StoragePermissionBanner";
import { hasStoragePermission } from "../common/permissions";

export default function Filter({
  download,
}: {
  download: (options: {
    downloadHTML: boolean;
    downloadImages: boolean;
    downloadLinks: boolean;
    downloadAssets: boolean;
    downloadContentAsText: boolean;
    downloadDocuments: boolean;
    singleFile: boolean;
  }) => void;
  tabUrl: string;
}) {
  const { t } = useTranslation();
  const [showPermissionBanner, setShowPermissionBanner] = useState(false);
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const {
    options,
    isLoading,
    setDownloadHTML,
    setDownloadImages,
    setDownloadLinks,
    setDownloadAssets,
    setDownloadContentAsText,
    setDownloadDocuments,
    setSingleFile,
    setDownloadLinksFullScraping,
    setLinkedPagesMaxCount,
    setLinkedPagesDelay,
  } = useFilterOptions();

  const downloadOptions = useDownloadOptions();
  const { isLoadingFromStorage } = useStorageStatus();

  // Check permissions on mount
  useEffect(() => {
    const checkPermissions = async () => {
      try {
        const storagePermission = await hasStoragePermission();
        setHasPermission(storagePermission);

        // Show banner if permission is not granted and we haven't shown it before
        if (
          !storagePermission &&
          !localStorage.getItem("storage-banner-dismissed")
        ) {
          setShowPermissionBanner(true);
        }
      } catch (error) {
        console.error("Error checking permissions:", error);
        setHasPermission(false);
      }
    };

    checkPermissions();
  }, []);

  const handleDownload = async () => {
    download(downloadOptions);
  };

  const handleDownloadHTMLChange = (checked: CheckedState) => {
    const isChecked = !!checked;

    if (!isChecked && !options.downloadImages && !options.downloadLinks && !options.downloadAssets && !options.downloadContentAsText && !options.downloadDocuments) {
      setDownloadContentAsText(true);
    }

    setDownloadHTML(isChecked);
    if (isChecked) {
      setDownloadImages(true);
      setDownloadAssets(true);
    } else {
      setDownloadAssets(false);
      setDownloadLinks(false);
    }
  };

  const handleSingleFileChange = (checked: CheckedState) => {
    const isChecked = !!checked;
    if (isChecked) {
      setDownloadHTML(false);
      setDownloadImages(false);
      setDownloadLinks(false);
      setDownloadAssets(false);
      setDownloadContentAsText(false);
      setDownloadDocuments(false);
    }
    setSingleFile(isChecked);
  };

  const handleDownloadLinksChange = (checked: CheckedState) => {
    setDownloadLinks(!!checked);
  };

  const handlePermissionGranted = () => {
    setHasPermission(true);
    setShowPermissionBanner(false);
    window.location.reload();
  };

  const handlePermissionDenied = () => {
    setShowPermissionBanner(false);
    localStorage.setItem("storage-banner-dismissed", "true");
  };

  if (isLoading || isLoadingFromStorage) {
    return (
      <div className="p-4 space-y-4">
        <div className="h-12 bg-slate-200 rounded animate-pulse" />
        <div className="h-32 bg-slate-100 rounded animate-pulse" />
      </div>
    );
  }

  return (
    <div className="animate-fade-in space-y-6">
      {/* Permission Banners */}
      <div className="space-y-4">
        {showPermissionBanner && (
          <StoragePermissionBanner
            onPermissionGranted={handlePermissionGranted}
            onPermissionDenied={handlePermissionDenied}
          />
        )}
        {hasPermission === false && !showPermissionBanner && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-amber-500 flex-shrink-0 mt-0.5" />
            <span className="text-sm text-amber-800">
              {t('filter.permissionWarning')}
            </span>
          </div>
        )}
      </div>

      {/* Main Action Area */}
      <div className="card p-6 bg-gradient-to-br from-white to-slate-50 border-slate-200">
        <button
          onClick={handleDownload}
          className="btn-primary w-full flex items-center justify-center gap-3 text-lg py-4 shadow-lg shadow-indigo-500/20 hover:shadow-indigo-500/30 transform hover:-translate-y-0.5 transition-all cursor-pointer"
        >
          <Download className="w-6 h-6" />
          <span>{t('filter.startDownload')}</span>
        </button>

        <p className="text-center text-xs text-slate-500 mt-3">
          {options.singleFile
            ? t('filter.singleFileDescription')
            : t('filter.zipDescription')}
        </p>
      </div>

      {/* Configuration Section */}
      <div className="card overflow-hidden">
        <button
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="w-full flex items-center justify-between p-4 bg-slate-50 border-b border-slate-100 hover:bg-slate-100 transition-colors text-slate-700 font-medium cursor-pointer"
        >
          <div className="flex items-center gap-2">
            <Settings className="w-4 h-4 text-slate-500" />
            <span>{t('filter.configuration')}</span>
          </div>
          {showAdvanced ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>

        <div className={cn(
          "transition-all duration-300 ease-in-out",
          showAdvanced ? "max-h-[800px] opacity-100" : "max-h-0 opacity-0"
        )}>
          <div className="p-4 space-y-4 bg-white">

            {/* Mode Selection */}
            <div className="p-3 bg-slate-50 rounded-lg border border-slate-100">
              <div className="flex items-center gap-3">
                <Checkbox
                  id="singleFile"
                  checked={options.singleFile}
                  onCheckedChange={handleSingleFileChange}
                />
                <label htmlFor="singleFile" className="flex-1 cursor-pointer">
                  <div className="font-medium text-slate-900">{t('filter.singleFile')}</div>
                  <div className="text-xs text-slate-500">{t('filter.singleFileDescription')}</div>
                </label>
                <File className="w-5 h-5 text-slate-400" />
              </div>
            </div>

            <div className="border-t border-slate-100 my-2" />

            {/* Granular Options */}
            <div className={cn("space-y-3", options.singleFile && "opacity-50 pointer-events-none")}>
              <OptionItem
                id="downloadHTML"
                checked={options.downloadHTML}
                onChange={handleDownloadHTMLChange}
                label={t('filter.downloadHTML')}
                icon={<Layout className="w-4 h-4" />}
              />

              <OptionItem
                id="downloadImages"
                checked={options.downloadImages}
                onChange={(c: any) => setDownloadImages(!!c)}
                label={t('filter.downloadImages')}
                icon={<ImageIcon className="w-4 h-4" />}
              />

              <OptionItem
                id="downloadAssets"
                checked={options.downloadAssets}
                onChange={(c: any) => setDownloadAssets(!!c)}
                label={t('filter.downloadAssets')}
                icon={<FileCode className="w-4 h-4" />}
              />

              <OptionItem
                id="downloadDocuments"
                checked={options.downloadDocuments}
                onChange={(c: any) => setDownloadDocuments(!!c)}
                label={t('filter.downloadDocuments')}
                icon={<File className="w-4 h-4" />}
              />

              <OptionItem
                id="downloadContentAsText"
                checked={options.downloadContentAsText}
                onChange={(c: any) => setDownloadContentAsText(!!c)}
                label={t('filter.downloadContentAsText')}
                icon={<FileText className="w-4 h-4" />}
              />

              <OptionItem
                id="singleFile"
                checked={options.singleFile}
                onChange={(c: any) => setSingleFile(!!c)}
                label={t('filter.singleFile')}
                icon={<FileText className="w-4 h-4" />}
              />

              <div className="pt-2">
                <OptionItem
                  id="downloadLinks"
                  checked={options.downloadLinks}
                  onChange={handleDownloadLinksChange}
                  label={t('filter.downloadLinks')}
                  icon={<LinkIcon className="w-4 h-4" />}
                />

                {options.downloadLinks && (
                  <div className="mt-2 ml-7 space-y-3">
                    {/* Full Scraping Toggle */}
                    <div className="p-3 bg-blue-50 rounded border border-blue-100">
                      <div className="flex items-start gap-3">
                        <Checkbox
                          id="downloadLinksFullScraping"
                          checked={options.downloadLinksFullScraping || false}
                          onCheckedChange={(c: any) => setDownloadLinksFullScraping(!!c)}
                        />
                        <div className="flex-1">
                          <label htmlFor="downloadLinksFullScraping" className="cursor-pointer">
                            <div className="text-sm font-medium text-blue-900">
                              {t('filter.fullScraping')}
                            </div>
                            <div className="text-xs text-blue-600 mt-1">
                              {t('filter.fullScrapingInfo')}
                            </div>
                          </label>
                        </div>
                      </div>

                      {/* Advanced Options */}
                      {options.downloadLinksFullScraping && (
                        <div className="mt-3 pt-3 border-t border-blue-200 space-y-3">
                          {/* Max Pages */}
                          <div>
                            <label className="text-xs font-medium text-blue-900 block mb-1">
                              {t('filter.maxPages')}: {options.linkedPagesMaxCount || 500}
                            </label>
                            <input
                              type="range"
                              min="10"
                              max="500"
                              step="10"
                              value={options.linkedPagesMaxCount || 200}
                              onChange={(e) => setLinkedPagesMaxCount(parseInt(e.target.value))}
                              className="w-full h-2 bg-blue-200 rounded-lg appearance-none cursor-pointer"
                            />
                          </div>

                          {/* Delay Between Pages */}
                          <div>
                            <label className="text-xs font-medium text-blue-900 block mb-1">
                              {t('filter.pageDelay')}: {options.linkedPagesDelay || 500}ms
                            </label>
                            <input
                              type="range"
                              min="0"
                              max="2000"
                              step="100"
                              value={options.linkedPagesDelay || 500}
                              onChange={(e) => setLinkedPagesDelay(parseInt(e.target.value))}
                              className="w-full h-2 bg-blue-200 rounded-lg appearance-none cursor-pointer"
                            />
                          </div>

                          {/* Include External Links */}
                          {/* <div className="flex items-center gap-2">
                            <Checkbox
                              id="linkedPagesIncludeExternal"
                              checked={options.linkedPagesIncludeExternal || false}
                              onCheckedChange={(c: any) => setLinkedPagesIncludeExternal(!!c)}
                            />
                            <label htmlFor="linkedPagesIncludeExternal" className="text-xs text-blue-900 cursor-pointer">
                              {t('filter.includeExternal')}
                            </label>
                          </div> */}
                        </div>
                      )}
                    </div>

                    {/* Warning for simple mode */}
                    {!options.downloadLinksFullScraping && (
                      <div className="p-3 bg-red-50 text-red-600 text-xs rounded border border-red-100 flex items-start gap-2">
                        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                        <span>{t('filter.linksWarning')}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function OptionItem({ id, checked, onChange, label, icon }: any) {
  return (
    <div className="flex items-center gap-3 group">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={onChange}
      />
      <label htmlFor={id} className="flex-1 flex items-center gap-2 cursor-pointer select-none">
        <span className="text-slate-400 group-hover:text-brand transition-colors">{icon}</span>
        <span className="text-sm font-medium text-slate-700 group-hover:text-slate-900 transition-colors">{label}</span>
      </label>
    </div>
  );
}
