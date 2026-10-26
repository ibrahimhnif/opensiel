{{- define "opensiel.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "opensiel.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "opensiel.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "opensiel.labels" -}}
helm.sh/chart: {{ include "opensiel.chart" . }}
{{ include "opensiel.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "opensiel.selectorLabels" -}}
app.kubernetes.io/name: {{ include "opensiel.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "opensiel.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "opensiel.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "opensiel.secretName" -}}
{{- default (include "opensiel.fullname" .) .Values.secrets.existingSecret -}}
{{- end -}}

{{- define "opensiel.postgresServiceName" -}}
{{- printf "%s-postgres" (include "opensiel.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "opensiel.publicUrl" -}}
{{- if .Values.env.OPENSIEL_PUBLIC_URL -}}
{{- .Values.env.OPENSIEL_PUBLIC_URL -}}
{{- else if .Values.ingress.enabled -}}
{{- $host := (index .Values.ingress.hosts 0).host -}}
{{- $scheme := "http" -}}
{{- if .Values.ingress.tls -}}
{{- $scheme = "https" -}}
{{- end -}}
{{- printf "%s://%s" $scheme $host -}}
{{- else -}}
{{- printf "http://localhost:%v" .Values.service.port -}}
{{- end -}}
{{- end -}}
