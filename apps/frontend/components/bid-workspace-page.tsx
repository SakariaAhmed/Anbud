"use client";

import {
  ChangeEvent,
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import {
  ChevronLeft,
  FileUp,
  Loader2,
  Plus,
  Printer,
  ScanSearch,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { CardDescription } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BidAnalysisResponse, BidDetail, BidDocument, DocumentRole, RequirementType } from "@/lib/types";
import { DocumentSection } from "@/components/bid-workspace/document-section";
import { InsightsSidebar } from "@/components/bid-workspace/insights-sidebar";
import { RequirementsPanel } from "@/components/bid-workspace/requirements-panel";
import { SummaryCards } from "@/components/bid-workspace/summary-cards";
import { inferDocumentRole, latestDocument, roleLabel } from "@/components/bid-workspace/helpers";

export function BidWorkspacePage({ initialData }: { initialData: BidDetail }) {
  const [data, setData] = useState(initialData);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("alle");
  const [statusFilter, setStatusFilter] = useState("alle");
  const [categoryFilter, setCategoryFilter] = useState("alle");
  const [sortBy, setSortBy] = useState("status");
  const [selectedRequirementId, setSelectedRequirementId] = useState<string | null>(
    initialData.compliance_matrix[0]?.requirement_id ?? null
  );
  const [uploadingRole, setUploadingRole] = useState<DocumentRole | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [pendingDropFile, setPendingDropFile] = useState<File | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [requirementDialogOpen, setRequirementDialogOpen] = useState(false);
  const [requirementSaving, setRequirementSaving] = useState(false);
  const [deletingRequirementId, setDeletingRequirementId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [newRequirement, setNewRequirement] = useState({
    code: "",
    category: "",
    requirement_type: "Må" as RequirementType,
    scope_summary: "",
    source_reference: "",
    source_excerpt: "",
  });
  const deferredSearch = useDeferredValue(search);
  const dragDepthRef = useRef(0);

  useEffect(() => {
    if (!data.compliance_matrix.length) {
      setSelectedRequirementId(null);
      return;
    }

    const exists = data.compliance_matrix.some((row) => row.requirement_id === selectedRequirementId);
    if (!exists) {
      setSelectedRequirementId(data.compliance_matrix[0].requirement_id);
    }
  }, [data.compliance_matrix, selectedRequirementId]);

  const bilag1 = useMemo(() => latestDocument(data.documents, "bilag1"), [data.documents]);
  const bilag2 = useMemo(() => latestDocument(data.documents, "bilag2"), [data.documents]);
  const categories = useMemo(
    () =>
      Array.from(new Set(data.requirements.map((requirement) => requirement.category))).sort((a, b) =>
        a.localeCompare(b, "no")
      ),
    [data.requirements]
  );
  const requirementTypeCounts = useMemo(
    () =>
      data.requirements.reduce(
        (counts, requirement) => {
          counts[requirement.requirement_type] += 1;
          return counts;
        },
        { "Må": 0, "Bør": 0 } as Record<RequirementType, number>
      ),
    [data.requirements]
  );
  const statusCounts = useMemo(
    () =>
      data.compliance_matrix.reduce(
        (counts, row) => {
          counts[row.status] += 1;
          return counts;
        },
        {
          "Besvart": 0,
          "Delvis besvart": 0,
          "Ikke besvart": 0,
        } as Record<"Besvart" | "Delvis besvart" | "Ikke besvart", number>
      ),
    [data.compliance_matrix]
  );

  const filteredRows = useMemo(() => {
    const query = deferredSearch.trim().toLowerCase();
    const order = { "Ikke besvart": 0, "Delvis besvart": 1, Besvart: 2 };

    return data.compliance_matrix
      .filter((row) => {
        if (!query) return true;
        return (
          row.requirement_code.toLowerCase().includes(query) ||
          row.requirement_summary.toLowerCase().includes(query) ||
          row.source_reference.toLowerCase().includes(query) ||
          (row.found_in ?? "").toLowerCase().includes(query)
        );
      })
      .filter((row) => (typeFilter === "alle" ? true : row.requirement_type === typeFilter))
      .filter((row) => (statusFilter === "alle" ? true : row.status === statusFilter))
      .filter((row) => (categoryFilter === "alle" ? true : row.category === categoryFilter))
      .sort((left, right) => {
        if (sortBy === "source") {
          return left.source_reference.localeCompare(right.source_reference, "no");
        }
        if (sortBy === "code") {
          return left.requirement_code.localeCompare(right.requirement_code, "no", { numeric: true });
        }

        const statusSort = order[left.status] - order[right.status];
        if (statusSort !== 0) {
          return statusSort;
        }
        return left.requirement_code.localeCompare(right.requirement_code, "no", { numeric: true });
      });
  }, [categoryFilter, data.compliance_matrix, deferredSearch, sortBy, statusFilter, typeFilter]);

  const selectedRow = useMemo(
    () => filteredRows.find((row) => row.requirement_id === selectedRequirementId) ?? filteredRows[0] ?? null,
    [filteredRows, selectedRequirementId]
  );

  const applyDetail = useCallback((detail: BidDetail) => {
    startTransition(() => {
      setData(detail);
    });
  }, []);

  const uploadFile = useCallback(async (role: DocumentRole, file: File) => {
    setUploadingRole(role);
    setMessage("");

    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("document_role", role);

      const response = await fetch(`/api/v1/bids/${data.id}/documents`, {
        method: "POST",
        headers: { "x-tenant-id": "default" },
        body: formData,
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { detail?: string };
        throw new Error(payload.detail || `Opplasting feilet (${response.status})`);
      }

      const payload = (await response.json()) as { document: BidDocument };
      startTransition(() => {
        setData((current) => ({
          ...current,
          documents: [payload.document, ...current.documents],
        }));
      });
      setMessage(`${roleLabel(role)} ble lastet opp.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Kunne ikke laste opp dokumentet.");
    } finally {
      setUploadingRole(null);
    }
  }, [data.id]);

  async function uploadDocument(role: DocumentRole, event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    await uploadFile(role, file);
    event.target.value = "";
  }

  async function runAnalysis() {
    setAnalysisLoading(true);
    setMessage("");

    try {
      const response = await fetch(`/api/v1/bids/${data.id}/analysis`, {
        method: "POST",
        headers: { "x-tenant-id": "default" },
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { detail?: string };
        throw new Error(payload.detail || `Analyse feilet (${response.status})`);
      }

      const payload = (await response.json()) as BidAnalysisResponse;
      startTransition(() => {
        setData((current) => ({
          ...current,
          requirements: payload.requirements,
          customer_analysis: payload.customer_analysis,
          compliance_matrix: payload.compliance_matrix,
          summary: payload.summary,
        }));
      });
      setMessage("Analyse oppdatert.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Kunne ikke kjøre analyse.");
    } finally {
      setAnalysisLoading(false);
    }
  }

  function downloadDocument(documentId: string) {
    window.open(`/api/v1/bids/${data.id}/documents/${documentId}`, "_blank", "noopener,noreferrer");
  }

  const printResults = useCallback(() => {
    window.print();
  }, []);

  const createRequirement = useCallback(async () => {
    setRequirementSaving(true);
    setMessage("");

    try {
      const response = await fetch(`/api/v1/bids/${data.id}/requirements`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-tenant-id": "default",
        },
        body: JSON.stringify(newRequirement),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { detail?: string };
        throw new Error(payload.detail || `Kunne ikke legge til krav (${response.status})`);
      }

      const payload = (await response.json()) as BidDetail;
      applyDetail(payload);
      setRequirementDialogOpen(false);
      setNewRequirement({
        code: "",
        category: "",
        requirement_type: "Må",
        scope_summary: "",
        source_reference: "",
        source_excerpt: "",
      });
      setMessage("Kravet ble lagt til manuelt.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Kunne ikke legge til krav.");
    } finally {
      setRequirementSaving(false);
    }
  }, [applyDetail, data.id, newRequirement]);

  const removeRequirement = useCallback(
    async (requirementId: string) => {
      const target = data.compliance_matrix.find((row) => row.requirement_id === requirementId);
      const shouldDelete = window.confirm(
        `Slett ${target?.requirement_code ?? "kravet"}? Dette fjerner også eventuell compliance-status for kravet.`
      );

      if (!shouldDelete) {
        return;
      }

      setDeletingRequirementId(requirementId);
      setMessage("");

      try {
        const response = await fetch(`/api/v1/bids/${data.id}/requirements/${requirementId}`, {
          method: "DELETE",
          headers: { "x-tenant-id": "default" },
        });

        if (!response.ok) {
          const payload = (await response.json().catch(() => ({}))) as { detail?: string };
          throw new Error(payload.detail || `Kunne ikke slette krav (${response.status})`);
        }

        const payload = (await response.json()) as BidDetail;
        applyDetail(payload);
        setMessage("Kravet ble slettet.");
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Kunne ikke slette krav.");
      } finally {
        setDeletingRequirementId(null);
      }
    },
    [applyDetail, data.compliance_matrix, data.id]
  );

  const handleDroppedFile = useCallback((file: File) => {
    const inferredRole = inferDocumentRole(file.name);
    if (inferredRole) {
      void uploadFile(inferredRole, file);
      return;
    }

    setPendingDropFile(file);
    setMessage("");
  }, [uploadFile]);

  useEffect(() => {
    function handleWindowDragEnter(event: DragEvent) {
      if (!event.dataTransfer?.types.includes("Files")) {
        return;
      }

      event.preventDefault();
      dragDepthRef.current += 1;
      setDragActive(true);
    }

    function handleWindowDragOver(event: DragEvent) {
      if (!event.dataTransfer?.types.includes("Files")) {
        return;
      }

      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setDragActive(true);
    }

    function handleWindowDragLeave(event: DragEvent) {
      if (!event.dataTransfer?.types.includes("Files")) {
        return;
      }

      event.preventDefault();
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) {
        setDragActive(false);
      }
    }

    function handleWindowDrop(event: DragEvent) {
      if (!event.dataTransfer?.files?.length) {
        return;
      }

      event.preventDefault();
      dragDepthRef.current = 0;
      setDragActive(false);
      handleDroppedFile(event.dataTransfer.files[0]);
    }

    window.addEventListener("dragenter", handleWindowDragEnter);
    window.addEventListener("dragover", handleWindowDragOver);
    window.addEventListener("dragleave", handleWindowDragLeave);
    window.addEventListener("drop", handleWindowDrop);

    return () => {
      window.removeEventListener("dragenter", handleWindowDragEnter);
      window.removeEventListener("dragover", handleWindowDragOver);
      window.removeEventListener("dragleave", handleWindowDragLeave);
      window.removeEventListener("drop", handleWindowDrop);
    };
  }, [handleDroppedFile]);

  return (
    <>
      {dragActive ? (
        <div className="fixed inset-0 z-40 bg-slate-950/18 backdrop-blur-sm print:hidden">
          <div className="flex h-full items-center justify-center px-6">
            <div className="w-full max-w-3xl rounded-[2rem] border border-white/50 bg-white/92 p-8 shadow-[0_40px_140px_rgba(15,23,42,0.24)]">
              <div className="grid gap-6 text-center">
                <div className="mx-auto flex size-16 items-center justify-center rounded-full bg-sky-100 text-sky-900">
                  <FileUp className="size-8" />
                </div>
                <div className="space-y-2">
                  <p className="text-xs font-medium uppercase tracking-[0.28em] text-slate-500">Slipp dokument hvor som helst</p>
                  <h2 className="text-3xl font-semibold tracking-tight text-slate-950">
                    Dra dokumentet inn i arbeidsflaten og slipp det.
                  </h2>
                  <p className="text-base text-slate-600">
                    Hvis filnavnet er tydelig, legges den automatisk som Bilag 1 eller Bilag 2. Hvis ikke ber vi deg bekrefte.
                  </p>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-left">
                    <div className="text-sm font-medium text-slate-900">Bilag 1</div>
                    <div className="mt-1 text-sm text-slate-600">Kravspesifikasjon, behov, krav eller tilsvarende dokument.</div>
                  </div>
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-left">
                    <div className="text-sm font-medium text-slate-900">Bilag 2</div>
                    <div className="mt-1 text-sm text-slate-600">Leverandørens svar, besvarelse eller responsdokument.</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <Dialog
        open={Boolean(pendingDropFile)}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDropFile(null);
          }
        }}
      >
        <DialogContent className="max-w-lg rounded-[1.5rem] p-6">
          <DialogHeader>
            <DialogTitle>Bekreft dokumenttype</DialogTitle>
            <DialogDescription>
              Vi klarte ikke sikkert å avgjøre om dokumentet er Bilag 1 eller Bilag 2. Velg hvor filen skal lastes opp.
            </DialogDescription>
          </DialogHeader>

          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-sm text-slate-700">
            <div className="font-medium text-slate-950">{pendingDropFile?.name}</div>
            <div className="mt-1">Dokumentet blir lagt inn som nyeste fil for valgt bilag.</div>
          </div>

          <DialogFooter className="mt-2 border-t-0 bg-transparent p-0">
            <Button
              variant="outline"
              onClick={() => {
                setPendingDropFile(null);
              }}
            >
              Avbryt
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                if (!pendingDropFile) return;
                void uploadFile("bilag1", pendingDropFile);
                setPendingDropFile(null);
              }}
            >
              Last opp som Bilag 1
            </Button>
            <Button
              onClick={() => {
                if (!pendingDropFile) return;
                void uploadFile("bilag2", pendingDropFile);
                setPendingDropFile(null);
              }}
            >
              Last opp som Bilag 2
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={requirementDialogOpen}
        onOpenChange={(open) => {
          setRequirementDialogOpen(open);
        }}
      >
        <DialogContent className="max-w-2xl rounded-[1.5rem] p-6">
          <DialogHeader>
            <DialogTitle>Legg til krav manuelt</DialogTitle>
            <DialogDescription>
              Bruk dette når et krav mangler fra analysen eller må legges inn manuelt med tydelig kilde.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="requirement-code">Kravkode</Label>
              <Input
                id="requirement-code"
                onChange={(event) => setNewRequirement((current) => ({ ...current, code: event.target.value }))}
                placeholder="Krav 17"
                value={newRequirement.code}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="requirement-category">Kategori</Label>
              <Input
                id="requirement-category"
                onChange={(event) => setNewRequirement((current) => ({ ...current, category: event.target.value }))}
                placeholder="Sikkerhet"
                value={newRequirement.category}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="requirement-type">Type</Label>
              <select
                className="h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700"
                id="requirement-type"
                onChange={(event) =>
                  setNewRequirement((current) => ({
                    ...current,
                    requirement_type: event.target.value as RequirementType,
                  }))
                }
                value={newRequirement.requirement_type}
              >
                <option value="Må">Må</option>
                <option value="Bør">Bør</option>
              </select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="requirement-source">Kilde</Label>
              <Input
                id="requirement-source"
                onChange={(event) =>
                  setNewRequirement((current) => ({ ...current, source_reference: event.target.value }))
                }
                placeholder="Side 14 / kapittel 3.2"
                value={newRequirement.source_reference}
              />
            </div>
            <div className="grid gap-2 md:col-span-2">
              <Label htmlFor="requirement-summary">Kravtekst</Label>
              <textarea
                className="min-h-28 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
                id="requirement-summary"
                onChange={(event) =>
                  setNewRequirement((current) => ({ ...current, scope_summary: event.target.value }))
                }
                placeholder="Leverandør skal levere standard tjenester fra Atea AMS."
                value={newRequirement.scope_summary}
              />
            </div>
            <div className="grid gap-2 md:col-span-2">
              <Label htmlFor="requirement-excerpt">Kildeutdrag</Label>
              <textarea
                className="min-h-24 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
                id="requirement-excerpt"
                onChange={(event) =>
                  setNewRequirement((current) => ({ ...current, source_excerpt: event.target.value }))
                }
                placeholder="Kort utdrag fra Bilag 1 som viser hvor kravet kommer fra."
                value={newRequirement.source_excerpt}
              />
            </div>
          </div>

          <DialogFooter className="mt-2 border-t-0 bg-transparent p-0">
            <Button onClick={() => setRequirementDialogOpen(false)} variant="outline">
              Avbryt
            </Button>
            <Button disabled={requirementSaving} onClick={() => void createRequirement()}>
              {requirementSaving ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
              Legg til krav
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-8 px-4 py-6 md:px-8 print:max-w-none print:gap-5 print:px-0 print:py-0">
      <section className="hidden print:block">
        <div className="border-b border-slate-300 pb-4">
          <p className="text-[11px] font-medium uppercase tracking-[0.28em] text-slate-500">Compliance-rapport</p>
          <div className="mt-2 flex items-end justify-between gap-6">
            <div>
              <h1 className="text-3xl font-semibold text-slate-950">{data.customer_name}</h1>
              <p className="mt-1 text-sm text-slate-600">{data.title}</p>
            </div>
            <div className="text-right text-xs text-slate-500">
              <div>Generert {new Date().toLocaleString("nb-NO")}</div>
              <div>{bilag1 ? "Bilag 1 lastet opp" : "Bilag 1 mangler"} · {bilag2 ? "Bilag 2 lastet opp" : "Bilag 2 mangler"}</div>
            </div>
          </div>
        </div>
      </section>
      <header className="flex flex-col gap-4 border-b border-slate-200 pb-6 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-2">
          <Link className="inline-flex items-center gap-2 text-sm text-slate-500 hover:text-slate-900 print:hidden" href="/">
            <ChevronLeft className="size-4" />
            Til sakslisten
          </Link>
          <p className="text-xs font-medium uppercase tracking-[0.28em] text-slate-500">Analysearbeidsflate</p>
          <h1 className="text-3xl font-semibold tracking-tight text-slate-950">{data.customer_name}</h1>
          <p className="max-w-3xl text-sm text-slate-600">{data.title}</p>
        </div>

        <div className="flex flex-wrap items-center gap-3 print:hidden">
          <span className="rounded-full bg-slate-100 px-3 py-2 text-sm text-slate-700">
            {bilag1 ? "Bilag 1 lastet opp" : "Bilag 1 mangler"}
          </span>
          <span className="rounded-full bg-slate-100 px-3 py-2 text-sm text-slate-700">
            {bilag2 ? "Bilag 2 lastet opp" : "Bilag 2 mangler"}
          </span>
          <Button disabled={!bilag1 || analysisLoading} onClick={runAnalysis}>
            {analysisLoading ? <Loader2 className="size-4 animate-spin" /> : <ScanSearch className="size-4" />}
            Generer analyse
          </Button>
          <Button onClick={printResults} variant="outline">
            <Printer className="size-4" />
            Skriv ut PDF
          </Button>
        </div>
      </header>

      {message ? <p className="text-sm text-slate-600 print:hidden">{message}</p> : null}

      <DocumentSection
        documents={data.documents}
        onDownload={downloadDocument}
        onUpload={uploadDocument}
        uploadingRole={uploadingRole}
      />

      <SummaryCards summary={data.summary} />

      <section className="grid gap-6 print:grid-cols-1 2xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="grid gap-4">
          <RequirementsPanel
            categories={categories}
            categoryFilter={categoryFilter}
            deletingRequirementId={deletingRequirementId}
            filteredRows={filteredRows}
            onAddRequirement={() => setRequirementDialogOpen(true)}
            onCategoryFilterChange={setCategoryFilter}
            onDeleteRequirement={removeRequirement}
            onSearchChange={setSearch}
            onSelectRequirement={setSelectedRequirementId}
            onSortByChange={setSortBy}
            onStatusFilterChange={setStatusFilter}
            onTypeFilterChange={setTypeFilter}
            requirementTypeCounts={requirementTypeCounts}
            search={search}
            selectedRequirementId={selectedRequirementId}
            sortBy={sortBy}
            statusCounts={statusCounts}
            statusFilter={statusFilter}
            totalRequirements={data.summary.total_requirements}
            typeFilter={typeFilter}
          />
        </div>

        <InsightsSidebar customerAnalysis={data.customer_analysis} selectedRow={selectedRow} />
      </section>
      </div>
    </>
  );
}
