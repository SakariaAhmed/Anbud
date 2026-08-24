alter table generated_artifacts
  drop constraint if exists generated_artifacts_artifact_type_check;

alter table generated_artifacts
  add constraint generated_artifacts_artifact_type_check
  check (
    artifact_type in (
      'losningsutkast',
      'bilag1_rekonstruksjon',
      'forbedret_kravsvar',
      'tilbudsstrategi',
      'verdiargumentasjon',
      'anbefalt_arkitektur',
      'gjennomforing_og_risiko'
    )
  );
