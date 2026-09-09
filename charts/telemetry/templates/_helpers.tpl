{{- define "telemetry.labels" -}}
app.kubernetes.io/name: telemetry
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{- define "telemetry.selector" -}}
app.kubernetes.io/name: telemetry
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "telemetry.fullname" -}}
{{ .root.Release.Name }}-{{ .component }}
{{- end -}}

{{- define "telemetry.databaseUrl" -}}
postgres://{{ .Values.postgres.user }}:{{ .Values.postgres.password }}@{{ .Release.Name }}-postgres:5432/{{ .Values.postgres.database }}
{{- end -}}

{{- define "telemetry.mqttUrl" -}}
mqtt://{{ .Release.Name }}-mosquitto:1883
{{- end -}}
