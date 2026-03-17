"use client";

import { Loader2, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { BidComplianceRow, RequirementType } from "@/lib/types";

import { compactExcerpt, requirementSourceLabel, statusTone } from "./helpers";

interface RequirementsPanelProps {
  filteredRows: BidComplianceRow[];
  selectedRequirementId: string | null;
  deletingRequirementId: string | null;
  totalRequirements: number;
  requirementTypeCounts: Record<RequirementType, number>;
  statusCounts: Record<"Besvart" | "Delvis besvart" | "Ikke besvart", number>;
  categories: string[];
  search: string;
  typeFilter: string;
  statusFilter: string;
  categoryFilter: string;
  sortBy: string;
  onSearchChange: (value: string) => void;
  onTypeFilterChange: (value: string) => void;
  onStatusFilterChange: (value: string) => void;
  onCategoryFilterChange: (value: string) => void;
  onSortByChange: (value: string) => void;
  onAddRequirement: () => void;
  onSelectRequirement: (requirementId: string) => void;
  onDeleteRequirement: (requirementId: string) => void | Promise<void>;
}

export function RequirementsPanel({
  filteredRows,
  selectedRequirementId,
  deletingRequirementId,
  totalRequirements,
  requirementTypeCounts,
  statusCounts,
  categories,
  search,
  typeFilter,
  statusFilter,
  categoryFilter,
  sortBy,
  onSearchChange,
  onTypeFilterChange,
  onStatusFilterChange,
  onCategoryFilterChange,
  onSortByChange,
  onAddRequirement,
  onSelectRequirement,
  onDeleteRequirement,
}: RequirementsPanelProps) {
  return (
    <Card className="border border-foreground/10 bg-white/85 print:break-inside-avoid print:border-slate-300 print:bg-white">
      <CardHeader className="gap-3">
        <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <CardTitle>Krav og compliance</CardTitle>
            <CardDescription>
              Filtrer, legg til og slett krav. Kravene kommer fra Bilag 1, og hver rad viser referanse og utdrag.
            </CardDescription>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-sm text-slate-500">{filteredRows.length} rader vist</div>
            <Button className="print:hidden" onClick={onAddRequirement} variant="outline">
              <Plus className="size-4" />
              Legg til krav
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="rounded-full bg-slate-100 px-3 py-1.5 text-slate-700">
            Totalt: <span className="font-semibold text-slate-950">{totalRequirements}</span>
          </span>
          <span className="rounded-full bg-sky-100 px-3 py-1.5 text-sky-900">
            Må: <span className="font-semibold">{requirementTypeCounts["Må"]}</span>
          </span>
          <span className="rounded-full bg-violet-100 px-3 py-1.5 text-violet-900">
            Bør: <span className="font-semibold">{requirementTypeCounts["Bør"]}</span>
          </span>
          <span className="rounded-full bg-emerald-100 px-3 py-1.5 text-emerald-900">
            Besvart: <span className="font-semibold">{statusCounts["Besvart"]}</span>
          </span>
          <span className="rounded-full bg-amber-100 px-3 py-1.5 text-amber-900">
            Delvis: <span className="font-semibold">{statusCounts["Delvis besvart"]}</span>
          </span>
          <span className="rounded-full bg-rose-100 px-3 py-1.5 text-rose-900">
            Ikke besvart: <span className="font-semibold">{statusCounts["Ikke besvart"]}</span>
          </span>
        </div>

        <div className="grid gap-3 print:hidden lg:grid-cols-[1.6fr_repeat(4,minmax(0,1fr))]">
          <Input
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Søk i krav, kilde eller funnet i dokument"
            value={search}
          />
          <select
            className="h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700"
            onChange={(event) => onTypeFilterChange(event.target.value)}
            value={typeFilter}
          >
            <option value="alle">Alle typer</option>
            <option value="Må">Må</option>
            <option value="Bør">Bør</option>
          </select>
          <select
            className="h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700"
            onChange={(event) => onStatusFilterChange(event.target.value)}
            value={statusFilter}
          >
            <option value="alle">Alle statuser</option>
            <option value="Besvart">Besvart</option>
            <option value="Delvis besvart">Delvis besvart</option>
            <option value="Ikke besvart">Ikke besvart</option>
          </select>
          <select
            className="h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700"
            onChange={(event) => onCategoryFilterChange(event.target.value)}
            value={categoryFilter}
          >
            <option value="alle">Alle kategorier</option>
            {categories.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>
          <select
            className="h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700"
            onChange={(event) => onSortByChange(event.target.value)}
            value={sortBy}
          >
            <option value="status">Sorter på status</option>
            <option value="source">Sorter på kilde</option>
            <option value="code">Sorter på kravkode</option>
          </select>
        </div>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Krav</TableHead>
              <TableHead>Kategori</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Funnet i dokument</TableHead>
              <TableHead>Kildegrunnlag</TableHead>
              <TableHead className="print:hidden text-right">Handling</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredRows.length ? (
              filteredRows.map((row) => (
                <TableRow
                  className={row.requirement_id === selectedRequirementId ? "bg-slate-100/80 hover:bg-slate-100/80" : ""}
                  key={row.requirement_id}
                  onClick={() => onSelectRequirement(row.requirement_id)}
                >
                  <TableCell className="min-w-[340px] whitespace-normal">
                    <div className="space-y-1">
                      <div className="font-medium text-slate-950">{row.requirement_code}</div>
                      <div className="text-sm text-slate-700">{row.requirement_summary}</div>
                      <div className="flex flex-wrap items-center gap-2 pt-1">
                        <span className="rounded-full bg-sky-100 px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.14em] text-sky-950">
                          {requirementSourceLabel()}
                        </span>
                        <span className="text-xs text-slate-500">{row.source_reference || "Referanse i Bilag 1 mangler"}</span>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>{row.category}</TableCell>
                  <TableCell>{row.requirement_type}</TableCell>
                  <TableCell>
                    <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusTone(row.status)}`}>
                      {row.status}
                    </span>
                  </TableCell>
                  <TableCell className="max-w-[220px] whitespace-normal text-sm text-slate-600">{row.found_in ?? "–"}</TableCell>
                  <TableCell className="max-w-[280px] whitespace-normal text-sm text-slate-600">
                    <div className="space-y-1.5">
                      <div className="font-medium text-slate-800">{row.source_reference || "Ingen presis referanse"}</div>
                      <div className="text-xs leading-5 text-slate-500">
                        {compactExcerpt(row.source_excerpt) || "Ingen kildeutdrag tilgjengelig."}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="print:hidden text-right">
                    <Button
                      disabled={deletingRequirementId === row.requirement_id}
                      onClick={(event) => {
                        event.stopPropagation();
                        void onDeleteRequirement(row.requirement_id);
                      }}
                      size="icon"
                      variant="ghost"
                    >
                      {deletingRequirementId === row.requirement_id ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Trash2 className="size-4 text-rose-700" />
                      )}
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell className="py-8 text-center text-slate-500" colSpan={7}>
                  Ingen rader matcher filtrene.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
