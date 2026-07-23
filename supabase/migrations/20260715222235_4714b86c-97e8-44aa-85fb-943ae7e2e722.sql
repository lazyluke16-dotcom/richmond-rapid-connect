
CREATE UNIQUE INDEX IF NOT EXISTS ai_provider_mappings_provider_assistant_uniq
  ON public.ai_provider_mappings(provider, provider_assistant_id)
  WHERE provider_assistant_id IS NOT NULL;

UPDATE public.business_ai_receptionist_settings
   SET provider = 'vapi',
       provider_assistant_id = '28a85bd5-5ccb-4605-a330-b62560e90aff',
       status = 'pending',
       enabled = true
 WHERE business_id = '45bf00ff-b5f2-43c8-aaaa-18298b85a2a9';

DELETE FROM public.ai_provider_mappings
 WHERE provider='vapi' AND provider_assistant_id='28a85bd5-5ccb-4605-a330-b62560e90aff';

INSERT INTO public.ai_provider_mappings (business_id, provider, provider_assistant_id, active)
VALUES ('45bf00ff-b5f2-43c8-aaaa-18298b85a2a9','vapi','28a85bd5-5ccb-4605-a330-b62560e90aff', true);
