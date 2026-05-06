alter table documents
drop constraint if exists documents_file_format_check;

alter table documents
add constraint documents_file_format_check
check (file_format in ('pdf', 'docx', 'txt', 'md', 'xlsx', 'xls'));
