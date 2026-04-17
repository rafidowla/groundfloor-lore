# Standard Operating Procedure: HR Policy Ingestion

**Purpose:** 
This SOP dictates how the Digital Employee (AI Agent) should extract monolithic corporate documents and insert them into the Lore Knowledge Engine as granular, Role-Based Access Control (ReBAC) policies.

**Trigger:**
Execution is initiated when a user attaches an HR Document (e.g. PDF or Markdown) and explicitly asks for it to be ingested.

## Step-by-Step Instructions for the Digital Employee

1. **Read Document:**
   Use your file reading tools (or `read_document_for_ingestion`) to completely read the target text.

2. **Fragmentation Strategy:**
   DO NOT store the document as a single node. 
   Analyze the text and extract every single discrete policy rule (e.g. "VPs get Business Class", "Interns get $20/day per diem").

3. **Node Creation:**
   For each extracted rule:
   - Call `mcp_groundfloor-lore_store_node`.
   - Set `id` to a descriptive snake-case value (e.g., `policy_vp_travel`).
   - Set `type` strictly to `hr_policy`.
   - Ensure the JSON `metadata` object includes `security_scopes: ["role:vp"]` (or whichever roles were detected in the text, e.g. `["role:all"]`).

4. **Edge Creation (ReBAC Relationships):**
   For each created `hr_policy` node:
   - Identify the exact `role` nodes it applies to.
   - If the `role` node does not exist, create it (e.g., `id: role_vp`, `type: role`, `label: Vice President`).
   - Call `mcp_groundfloor-lore_store_edge`.
   - Set `sourceId` to the `hr_policy` node ID.
   - Set `targetId` to the `role` node ID.
   - Set `relation` strictly to `applies_to`.

5. **Validation:**
   Run `mcp_groundfloor-lore_stats` to verify that the nodes and edges count incremented appropriately. Provide the final list of fragmented nodes back to the user for approval.
