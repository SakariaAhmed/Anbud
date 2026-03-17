"use client";

import { ChangeEvent } from "react";
import { Download, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BidDocument, DocumentRole } from "@/lib/types";

import { latestDocument, roleLabel } from "./helpers";

interface DocumentSectionProps {
  documents: BidDocument[];
  uploadingRole: DocumentRole | null;
  onUpload: (role: DocumentRole, event: ChangeEvent<HTMLInputElement>) => void | Promise<void>;
  onDownload: (documentId: string) => void;
}

export function DocumentSection({ documents, uploadingRole, onUpload, onDownload }: DocumentSectionProps) {
  return (
    <section className="grid gap-4 print:hidden xl:grid-cols-2">
      {(["bilag1", "bilag2"] as DocumentRole[]).map((role) => {
        const document = latestDocument(documents, role);
        const isUploading = uploadingRole === role;

        return (
          <Card key={role} className="border border-foreground/10 bg-white/85">
            <CardHeader>
              <CardTitle>{roleLabel(role)}</CardTitle>
              <CardDescription>Støtter PDF, DOCX og TXT. Originalfil kan lastes ned igjen.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              {document ? (
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-sm font-medium text-slate-900">{document.file_name}</p>
                      <p className="text-xs text-slate-500">
                        {document.file_format.toUpperCase()} · lastet opp {document.created_at.slice(0, 10)}
                      </p>
                    </div>
                    <Button size="sm" variant="outline" onClick={() => onDownload(document.id)}>
                      <Download className="size-4" />
                      Last ned
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-500">
                  Ingen fil lastet opp ennå.
                </div>
              )}

              <div className="grid gap-2">
                <Label htmlFor={role}>Last opp {roleLabel(role)}</Label>
                <Input
                  accept=".pdf,.docx,.txt"
                  disabled={isUploading}
                  id={role}
                  onChange={(event) => {
                    void onUpload(role, event);
                  }}
                  type="file"
                />
                {isUploading ? (
                  <div className="inline-flex items-center gap-2 text-sm text-slate-500">
                    <Loader2 className="size-4 animate-spin" />
                    Laster opp...
                  </div>
                ) : null}
              </div>
            </CardContent>
          </Card>
        );
      })}
    </section>
  );
}
