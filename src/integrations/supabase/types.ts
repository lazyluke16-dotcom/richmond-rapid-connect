export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      ai_provider_mappings: {
        Row: {
          active: boolean
          business_id: string
          created_at: string
          id: string
          integration_token_hash: string | null
          notes: string | null
          provider: string
          provider_assistant_id: string | null
          provider_phone_id: string | null
          provider_phone_number: string | null
          updated_at: string
        }
        Insert: {
          active?: boolean
          business_id: string
          created_at?: string
          id?: string
          integration_token_hash?: string | null
          notes?: string | null
          provider?: string
          provider_assistant_id?: string | null
          provider_phone_id?: string | null
          provider_phone_number?: string | null
          updated_at?: string
        }
        Update: {
          active?: boolean
          business_id?: string
          created_at?: string
          id?: string
          integration_token_hash?: string | null
          notes?: string | null
          provider?: string
          provider_assistant_id?: string | null
          provider_phone_id?: string | null
          provider_phone_number?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_provider_mappings_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_provider_mappings_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses_public"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_config: {
        Row: {
          active: boolean
          currency: string | null
          key: string
          notes: string | null
          updated_at: string
          value_numeric: number | null
          value_text: string | null
        }
        Insert: {
          active?: boolean
          currency?: string | null
          key: string
          notes?: string | null
          updated_at?: string
          value_numeric?: number | null
          value_text?: string | null
        }
        Update: {
          active?: boolean
          currency?: string | null
          key?: string
          notes?: string | null
          updated_at?: string
          value_numeric?: number | null
          value_text?: string | null
        }
        Relationships: []
      }
      billing_usage_alerts_sent: {
        Row: {
          business_id: string
          created_at: string
          id: string
          period_start: string
          sent_at: string
          threshold_aud: number
        }
        Insert: {
          business_id: string
          created_at?: string
          id?: string
          period_start: string
          sent_at?: string
          threshold_aud: number
        }
        Update: {
          business_id?: string
          created_at?: string
          id?: string
          period_start?: string
          sent_at?: string
          threshold_aud?: number
        }
        Relationships: [
          {
            foreignKeyName: "billing_usage_alerts_sent_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_usage_alerts_sent_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses_public"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_usage_events: {
        Row: {
          billable: boolean
          billable_seconds: number | null
          billing_period_end: string | null
          billing_period_start: string | null
          business_id: string
          created_at: string
          customer_rate: number | null
          customer_rate_currency: string
          ended_at: string | null
          estimated_customer_charge: number | null
          external_call_id: string | null
          id: string
          metadata: Json
          non_billable_reason: string | null
          provider: string
          provider_cost_amount: number | null
          provider_cost_currency: string | null
          provider_event_id: string | null
          quantity: number
          started_at: string | null
          stripe_meter_event_attempt_count: number
          stripe_meter_event_error: string | null
          stripe_meter_event_identifier: string | null
          stripe_meter_event_last_attempt_at: string | null
          stripe_meter_event_sent_at: string | null
          stripe_meter_event_status: string | null
          unit: string
          usage_type: string
        }
        Insert: {
          billable?: boolean
          billable_seconds?: number | null
          billing_period_end?: string | null
          billing_period_start?: string | null
          business_id: string
          created_at?: string
          customer_rate?: number | null
          customer_rate_currency?: string
          ended_at?: string | null
          estimated_customer_charge?: number | null
          external_call_id?: string | null
          id?: string
          metadata?: Json
          non_billable_reason?: string | null
          provider: string
          provider_cost_amount?: number | null
          provider_cost_currency?: string | null
          provider_event_id?: string | null
          quantity: number
          started_at?: string | null
          stripe_meter_event_attempt_count?: number
          stripe_meter_event_error?: string | null
          stripe_meter_event_identifier?: string | null
          stripe_meter_event_last_attempt_at?: string | null
          stripe_meter_event_sent_at?: string | null
          stripe_meter_event_status?: string | null
          unit: string
          usage_type: string
        }
        Update: {
          billable?: boolean
          billable_seconds?: number | null
          billing_period_end?: string | null
          billing_period_start?: string | null
          business_id?: string
          created_at?: string
          customer_rate?: number | null
          customer_rate_currency?: string
          ended_at?: string | null
          estimated_customer_charge?: number | null
          external_call_id?: string | null
          id?: string
          metadata?: Json
          non_billable_reason?: string | null
          provider?: string
          provider_cost_amount?: number | null
          provider_cost_currency?: string | null
          provider_event_id?: string | null
          quantity?: number
          started_at?: string | null
          stripe_meter_event_attempt_count?: number
          stripe_meter_event_error?: string | null
          stripe_meter_event_identifier?: string | null
          stripe_meter_event_last_attempt_at?: string | null
          stripe_meter_event_sent_at?: string | null
          stripe_meter_event_status?: string | null
          unit?: string
          usage_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "billing_usage_events_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_usage_events_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses_public"
            referencedColumns: ["id"]
          },
        ]
      }
      business_ai_receptionist_settings: {
        Row: {
          activated_at: string | null
          ai_summary_enabled: boolean
          assistant_name: string
          business_id: string
          callback_message: string
          created_at: string
          emergency_response: string
          enabled: boolean
          first_message: string
          human_request_response: string
          id: string
          language: string
          max_call_duration_seconds: number
          mode: string
          pricing_response: string
          provider: string
          provider_assistant_id: string | null
          provider_phone_id: string | null
          provider_phone_number: string | null
          recording_enabled: boolean
          status: string
          tone: string
          transcript_enabled: boolean
          updated_at: string
          voice_id: string | null
          voice_provider: string | null
        }
        Insert: {
          activated_at?: string | null
          ai_summary_enabled?: boolean
          assistant_name?: string
          business_id: string
          callback_message?: string
          created_at?: string
          emergency_response?: string
          enabled?: boolean
          first_message?: string
          human_request_response?: string
          id?: string
          language?: string
          max_call_duration_seconds?: number
          mode?: string
          pricing_response?: string
          provider?: string
          provider_assistant_id?: string | null
          provider_phone_id?: string | null
          provider_phone_number?: string | null
          recording_enabled?: boolean
          status?: string
          tone?: string
          transcript_enabled?: boolean
          updated_at?: string
          voice_id?: string | null
          voice_provider?: string | null
        }
        Update: {
          activated_at?: string | null
          ai_summary_enabled?: boolean
          assistant_name?: string
          business_id?: string
          callback_message?: string
          created_at?: string
          emergency_response?: string
          enabled?: boolean
          first_message?: string
          human_request_response?: string
          id?: string
          language?: string
          max_call_duration_seconds?: number
          mode?: string
          pricing_response?: string
          provider?: string
          provider_assistant_id?: string | null
          provider_phone_id?: string | null
          provider_phone_number?: string | null
          recording_enabled?: boolean
          status?: string
          tone?: string
          transcript_enabled?: boolean
          updated_at?: string
          voice_id?: string | null
          voice_provider?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "business_ai_receptionist_settings_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: true
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "business_ai_receptionist_settings_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: true
            referencedRelation: "businesses_public"
            referencedColumns: ["id"]
          },
        ]
      }
      business_billing: {
        Row: {
          billing_cycle_anchor: string | null
          billing_status: string
          business_id: string
          canceled_at: string | null
          created_at: string
          current_period_end: string | null
          current_period_start: string | null
          grace_expires_at: string | null
          grace_started_at: string | null
          id: string
          last_synced_at: string | null
          past_due_usage_limit_cents: number
          platform_fee_waiver_ends_at: string | null
          selected_plan: string | null
          stripe_base_price_id: string | null
          stripe_customer_id: string | null
          stripe_subscription_id: string | null
          stripe_subscription_status: string | null
          stripe_usage_price_id: string | null
          successful_invoice_count: number
          suspended_at: string | null
          union_offer_eligible: boolean
          union_offer_redeemed_at: string | null
          updated_at: string
          usage_limit_cents: number
        }
        Insert: {
          billing_cycle_anchor?: string | null
          billing_status?: string
          business_id: string
          canceled_at?: string | null
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          grace_expires_at?: string | null
          grace_started_at?: string | null
          id?: string
          last_synced_at?: string | null
          past_due_usage_limit_cents?: number
          platform_fee_waiver_ends_at?: string | null
          selected_plan?: string | null
          stripe_base_price_id?: string | null
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          stripe_subscription_status?: string | null
          stripe_usage_price_id?: string | null
          successful_invoice_count?: number
          suspended_at?: string | null
          union_offer_eligible?: boolean
          union_offer_redeemed_at?: string | null
          updated_at?: string
          usage_limit_cents?: number
        }
        Update: {
          billing_cycle_anchor?: string | null
          billing_status?: string
          business_id?: string
          canceled_at?: string | null
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          grace_expires_at?: string | null
          grace_started_at?: string | null
          id?: string
          last_synced_at?: string | null
          past_due_usage_limit_cents?: number
          platform_fee_waiver_ends_at?: string | null
          selected_plan?: string | null
          stripe_base_price_id?: string | null
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          stripe_subscription_status?: string | null
          stripe_usage_price_id?: string | null
          successful_invoice_count?: number
          suspended_at?: string | null
          union_offer_eligible?: boolean
          union_offer_redeemed_at?: string | null
          updated_at?: string
          usage_limit_cents?: number
        }
        Relationships: [
          {
            foreignKeyName: "business_billing_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: true
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "business_billing_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: true
            referencedRelation: "businesses_public"
            referencedColumns: ["id"]
          },
        ]
      }
      business_hours: {
        Row: {
          business_id: string
          close_time: string | null
          closed: boolean
          created_at: string
          day_of_week: number
          id: string
          open_time: string | null
          updated_at: string
        }
        Insert: {
          business_id: string
          close_time?: string | null
          closed?: boolean
          created_at?: string
          day_of_week: number
          id?: string
          open_time?: string | null
          updated_at?: string
        }
        Update: {
          business_id?: string
          close_time?: string | null
          closed?: boolean
          created_at?: string
          day_of_week?: number
          id?: string
          open_time?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "business_hours_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "business_hours_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses_public"
            referencedColumns: ["id"]
          },
        ]
      }
      business_missed_call_settings: {
        Row: {
          alert_email: string | null
          alert_method: string
          alert_phone: string | null
          business_id: string
          callback_message: string | null
          created_at: string
          enabled: boolean
          id: string
          mode: string
          plumber_alert_enabled: boolean
          recovery_sms_enabled: boolean
          sms_template: string
          updated_at: string
        }
        Insert: {
          alert_email?: string | null
          alert_method?: string
          alert_phone?: string | null
          business_id: string
          callback_message?: string | null
          created_at?: string
          enabled?: boolean
          id?: string
          mode?: string
          plumber_alert_enabled?: boolean
          recovery_sms_enabled?: boolean
          sms_template?: string
          updated_at?: string
        }
        Update: {
          alert_email?: string | null
          alert_method?: string
          alert_phone?: string | null
          business_id?: string
          callback_message?: string | null
          created_at?: string
          enabled?: boolean
          id?: string
          mode?: string
          plumber_alert_enabled?: boolean
          recovery_sms_enabled?: boolean
          sms_template?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "business_missed_call_settings_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: true
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "business_missed_call_settings_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: true
            referencedRelation: "businesses_public"
            referencedColumns: ["id"]
          },
        ]
      }
      business_service_areas: {
        Row: {
          active: boolean
          business_id: string
          created_at: string
          display_order: number
          id: string
          postcode: string | null
          state: string | null
          suburb: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          business_id: string
          created_at?: string
          display_order?: number
          id?: string
          postcode?: string | null
          state?: string | null
          suburb: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          business_id?: string
          created_at?: string
          display_order?: number
          id?: string
          postcode?: string | null
          state?: string | null
          suburb?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "business_service_areas_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "business_service_areas_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses_public"
            referencedColumns: ["id"]
          },
        ]
      }
      business_services: {
        Row: {
          active: boolean
          business_id: string
          created_at: string
          description: string | null
          display_name: string
          display_order: number
          id: string
          service_key: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          business_id: string
          created_at?: string
          description?: string | null
          display_name: string
          display_order?: number
          id?: string
          service_key: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          business_id?: string
          created_at?: string
          description?: string | null
          display_name?: string
          display_order?: number
          id?: string
          service_key?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "business_services_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "business_services_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses_public"
            referencedColumns: ["id"]
          },
        ]
      }
      business_telephony_settings: {
        Row: {
          activated_at: string | null
          business_id: string
          created_at: string
          forwarding_number: string | null
          id: string
          inbound_number: string | null
          live_status: string
          provider: string | null
          provider_phone_id: string | null
          updated_at: string
        }
        Insert: {
          activated_at?: string | null
          business_id: string
          created_at?: string
          forwarding_number?: string | null
          id?: string
          inbound_number?: string | null
          live_status?: string
          provider?: string | null
          provider_phone_id?: string | null
          updated_at?: string
        }
        Update: {
          activated_at?: string | null
          business_id?: string
          created_at?: string
          forwarding_number?: string | null
          id?: string
          inbound_number?: string | null
          live_status?: string
          provider?: string | null
          provider_phone_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "business_telephony_settings_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: true
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "business_telephony_settings_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: true
            referencedRelation: "businesses_public"
            referencedColumns: ["id"]
          },
        ]
      }
      business_users: {
        Row: {
          business_id: string
          created_at: string
          id: string
          role: string
          user_id: string
        }
        Insert: {
          business_id: string
          created_at?: string
          id?: string
          role?: string
          user_id: string
        }
        Update: {
          business_id?: string
          created_at?: string
          id?: string
          role?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "business_users_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "business_users_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses_public"
            referencedColumns: ["id"]
          },
        ]
      }
      businesses: {
        Row: {
          accent_colour: string | null
          active: boolean
          alert_phone: string | null
          base_postcode: string | null
          base_state: string | null
          base_suburb: string | null
          billing_exempt: boolean
          created_at: string
          email: string | null
          emergency_message: string | null
          excluded_areas: string[]
          hero_heading: string | null
          hero_subheading: string | null
          id: string
          licence_expiry: string | null
          licence_holder_name: string | null
          licence_number: string | null
          licence_public: boolean
          logo_url: string | null
          name: string
          onboarding_completed: boolean
          onboarding_step: number
          owner_user_id: string | null
          partner_code: string | null
          phone: string | null
          postcode_ranges: string[]
          primary_colour: string | null
          public_email: string | null
          public_phone: string | null
          referral_code: string | null
          region_labels: string[]
          secondary_colour: string | null
          selected_plan: string | null
          short_description: string | null
          signup_source: string | null
          slug: string
          travel_radius_km: number | null
          trial_ends_at: string | null
          trial_started_at: string | null
          updated_at: string
        }
        Insert: {
          accent_colour?: string | null
          active?: boolean
          alert_phone?: string | null
          base_postcode?: string | null
          base_state?: string | null
          base_suburb?: string | null
          billing_exempt?: boolean
          created_at?: string
          email?: string | null
          emergency_message?: string | null
          excluded_areas?: string[]
          hero_heading?: string | null
          hero_subheading?: string | null
          id?: string
          licence_expiry?: string | null
          licence_holder_name?: string | null
          licence_number?: string | null
          licence_public?: boolean
          logo_url?: string | null
          name: string
          onboarding_completed?: boolean
          onboarding_step?: number
          owner_user_id?: string | null
          partner_code?: string | null
          phone?: string | null
          postcode_ranges?: string[]
          primary_colour?: string | null
          public_email?: string | null
          public_phone?: string | null
          referral_code?: string | null
          region_labels?: string[]
          secondary_colour?: string | null
          selected_plan?: string | null
          short_description?: string | null
          signup_source?: string | null
          slug: string
          travel_radius_km?: number | null
          trial_ends_at?: string | null
          trial_started_at?: string | null
          updated_at?: string
        }
        Update: {
          accent_colour?: string | null
          active?: boolean
          alert_phone?: string | null
          base_postcode?: string | null
          base_state?: string | null
          base_suburb?: string | null
          billing_exempt?: boolean
          created_at?: string
          email?: string | null
          emergency_message?: string | null
          excluded_areas?: string[]
          hero_heading?: string | null
          hero_subheading?: string | null
          id?: string
          licence_expiry?: string | null
          licence_holder_name?: string | null
          licence_number?: string | null
          licence_public?: boolean
          logo_url?: string | null
          name?: string
          onboarding_completed?: boolean
          onboarding_step?: number
          owner_user_id?: string | null
          partner_code?: string | null
          phone?: string | null
          postcode_ranges?: string[]
          primary_colour?: string | null
          public_email?: string | null
          public_phone?: string | null
          referral_code?: string | null
          region_labels?: string[]
          secondary_colour?: string | null
          selected_plan?: string | null
          short_description?: string | null
          signup_source?: string | null
          slug?: string
          travel_radius_km?: number | null
          trial_ends_at?: string | null
          trial_started_at?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      enrichment_jobs: {
        Row: {
          attempt_count: number
          business_id: string
          call_id: string
          created_at: string
          error_message: string | null
          id: string
          lead_id: string
          max_attempts: number
          processing_started_at: string | null
          run_after: string
          status: string
          updated_at: string
        }
        Insert: {
          attempt_count?: number
          business_id: string
          call_id: string
          created_at?: string
          error_message?: string | null
          id?: string
          lead_id: string
          max_attempts?: number
          processing_started_at?: string | null
          run_after?: string
          status?: string
          updated_at?: string
        }
        Update: {
          attempt_count?: number
          business_id?: string
          call_id?: string
          created_at?: string
          error_message?: string | null
          id?: string
          lead_id?: string
          max_attempts?: number
          processing_started_at?: string | null
          run_after?: string
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      leads: {
        Row: {
          ai_summary: string | null
          best_time: string | null
          business_id: string
          call_recording_url: string | null
          chat: Json | null
          created_at: number
          external_call_id: string | null
          id: string
          job_type: string
          lead_score: number | null
          name: string
          phone: string
          photos: Json | null
          property_type: string
          recommended_action: string | null
          source: string | null
          status: string | null
          suburb: string
          urgency: string
        }
        Insert: {
          ai_summary?: string | null
          best_time?: string | null
          business_id: string
          call_recording_url?: string | null
          chat?: Json | null
          created_at: number
          external_call_id?: string | null
          id: string
          job_type: string
          lead_score?: number | null
          name: string
          phone: string
          photos?: Json | null
          property_type: string
          recommended_action?: string | null
          source?: string | null
          status?: string | null
          suburb: string
          urgency: string
        }
        Update: {
          ai_summary?: string | null
          best_time?: string | null
          business_id?: string
          call_recording_url?: string | null
          chat?: Json | null
          created_at?: number
          external_call_id?: string | null
          id?: string
          job_type?: string
          lead_score?: number | null
          name?: string
          phone?: string
          photos?: Json | null
          property_type?: string
          recommended_action?: string | null
          source?: string | null
          status?: string | null
          suburb?: string
          urgency?: string
        }
        Relationships: [
          {
            foreignKeyName: "leads_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses_public"
            referencedColumns: ["id"]
          },
        ]
      }
      missed_calls: {
        Row: {
          business_id: string
          caller_phone: string
          created_at: string | null
          id: string
          sms_event_id: string | null
          sms_sent: boolean | null
          source: string | null
        }
        Insert: {
          business_id: string
          caller_phone: string
          created_at?: string | null
          id?: string
          sms_event_id?: string | null
          sms_sent?: boolean | null
          source?: string | null
        }
        Update: {
          business_id?: string
          caller_phone?: string
          created_at?: string | null
          id?: string
          sms_event_id?: string | null
          sms_sent?: boolean | null
          source?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "missed_calls_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "missed_calls_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses_public"
            referencedColumns: ["id"]
          },
        ]
      }
      sms_events: {
        Row: {
          body: string
          business_id: string
          created_at: string | null
          error_message: string | null
          event_type: string
          from_number: string
          id: string
          mode: string
          status: string
          to_number: string
          twilio_sid: string | null
        }
        Insert: {
          body: string
          business_id: string
          created_at?: string | null
          error_message?: string | null
          event_type?: string
          from_number: string
          id?: string
          mode: string
          status: string
          to_number: string
          twilio_sid?: string | null
        }
        Update: {
          body?: string
          business_id?: string
          created_at?: string | null
          error_message?: string | null
          event_type?: string
          from_number?: string
          id?: string
          mode?: string
          status?: string
          to_number?: string
          twilio_sid?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sms_events_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sms_events_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses_public"
            referencedColumns: ["id"]
          },
        ]
      }
      stripe_webhook_events: {
        Row: {
          business_id: string | null
          error_message: string | null
          event_type: string
          id: string
          metadata: Json
          processed_at: string | null
          received_at: string
          status: string
          stripe_event_id: string
        }
        Insert: {
          business_id?: string | null
          error_message?: string | null
          event_type: string
          id?: string
          metadata?: Json
          processed_at?: string | null
          received_at?: string
          status?: string
          stripe_event_id: string
        }
        Update: {
          business_id?: string | null
          error_message?: string | null
          event_type?: string
          id?: string
          metadata?: Json
          processed_at?: string | null
          received_at?: string
          status?: string
          stripe_event_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "stripe_webhook_events_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stripe_webhook_events_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses_public"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      businesses_public: {
        Row: {
          accent_colour: string | null
          active: boolean | null
          emergency_message: string | null
          hero_heading: string | null
          hero_subheading: string | null
          id: string | null
          licence_expiry: string | null
          licence_holder_name: string | null
          licence_number: string | null
          licence_public: boolean | null
          logo_url: string | null
          name: string | null
          primary_colour: string | null
          public_email: string | null
          public_phone: string | null
          secondary_colour: string | null
          short_description: string | null
          slug: string | null
        }
        Insert: {
          accent_colour?: string | null
          active?: boolean | null
          emergency_message?: string | null
          hero_heading?: string | null
          hero_subheading?: string | null
          id?: string | null
          licence_expiry?: never
          licence_holder_name?: never
          licence_number?: never
          licence_public?: boolean | null
          logo_url?: string | null
          name?: string | null
          primary_colour?: string | null
          public_email?: string | null
          public_phone?: string | null
          secondary_colour?: string | null
          short_description?: string | null
          slug?: string | null
        }
        Update: {
          accent_colour?: string | null
          active?: boolean | null
          emergency_message?: string | null
          hero_heading?: string | null
          hero_subheading?: string | null
          id?: string | null
          licence_expiry?: never
          licence_holder_name?: never
          licence_number?: never
          licence_public?: boolean | null
          logo_url?: string | null
          name?: string | null
          primary_colour?: string | null
          public_email?: string | null
          public_phone?: string | null
          secondary_colour?: string | null
          short_description?: string | null
          slug?: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      business_feature_state: {
        Args: { _business_id: string }
        Returns: string
      }
      claim_enrichment_jobs: {
        Args: { _lease_seconds?: number; _limit?: number }
        Returns: {
          attempt_count: number
          business_id: string
          call_id: string
          id: string
          lead_id: string
          max_attempts: number
        }[]
      }
      create_business_for_current_user: {
        Args: {
          p_name: string
          p_partner_code?: string
          p_referral_code?: string
          p_signup_source?: string
          p_slug_base?: string
        }
        Returns: {
          id: string
          slug: string
        }[]
      }
      current_business_id: { Args: never; Returns: string }
      effective_billing_state: {
        Args: { _business_id: string }
        Returns: string
      }
      get_my_billing_detail: { Args: never; Returns: Json }
      get_my_billing_summary: {
        Args: never
        Returns: {
          billing_exempt: boolean
          billing_status: string
          business_id: string
          current_period_end: string
          current_period_start: string
          effective_state: string
          grace_expires_at: string
          has_stripe_customer: boolean
          has_stripe_subscription: boolean
          platform_fee_waiver_ends_at: string
          selected_plan: string
          union_offer_eligible: boolean
          union_offer_redeemed_at: string
          usage_limit_cents: number
        }[]
      }
      get_processor_key: { Args: never; Returns: string }
      has_ai_receptionist_access: {
        Args: { _business_id: string }
        Returns: boolean
      }
      has_missed_call_access: {
        Args: { _business_id: string }
        Returns: boolean
      }
      reserve_business_slug: { Args: { p_base: string }; Returns: string }
      resolve_ai_tenant: {
        Args: {
          _assistant_id: string
          _phone_id: string
          _phone_number: string
          _provider: string
        }
        Returns: string
      }
      update_my_business_slug: { Args: { p_new_slug: string }; Returns: string }
      validate_missed_call_attribution: {
        Args: { _business_id: string; _mcid: string }
        Returns: boolean
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
