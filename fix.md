- Admission and intake workflow - Ok
- Patient views and subviews - Ok
- Hope workflows - Hope assessment, HUV1, HUV2, SFV, Discharge assessment, admission assessment - Ok
- Put alerts for each sections of the hope assessment - Ok
- Patient care plan - Ok
- Add a button for new encounter and new visit - Ok
- Patient assessment  - Ok
"What the Assessment CoversPhysical Health: Tracking pain levels, breathing issues, fatigue, and other distressing symptoms.Functional Status: Measuring the patient's ability to perform daily tasks like eating, bathing, and walking.Psychosocial Needs: Evaluating how the patient and their family are coping emotionally and managing home dynamics.Spiritual Care: Identifying personal beliefs, values, or end-of-life rituals that bring comfort"
- Patient document: upload patient documents (from intake), polst, consent forms - Ok
- Referral inbox: upload file received from email, fax, pdf, word, physical copy that we need to scans - Ok

- Hearthnote*

# Admission workflow

- In the "Complete admission details" modal, the "Service location" should be the patient's residence address - Ok
- Notice of Rights can be scanned and uploaded - Ok
- Election Statement can be scanned and uploaded - Ok
- Sign Election Statement can be scanned and uploaded - Ok
- In the Sign Election Statement modal, put the option "care giver" as Signer role - Ok
- The CTI should be created and signed by the hospice physician ONLY (the one that we selected) - Ok
- Search for doctor's name - Ok
- In the "Create Certification of Terminal Illness" put the secondeary diagnisis field (it can be multiple) - Ok
- When signing the CTI, the doctor's name and NPI should pop up automatically - Ok
- In an encounter/visit, we should be able to create directly a care plan - Ok
- The care plan is dynamic, it can change when the patient condition change - Ok
- In the patient care creation, SNOMED code must be linked to ICD-10 code so that hen we type the ICD-10 code, it auto complet the SNOMED code
- In the patient care creation, when we hover the SUD-related checkbox we should see a definition of what it is - Ok
- In care plan workflow, once the care plan is reviewed, we send it to the hospice physician to review and sign - Ok

- Hope workflow, HUV1, HUV2, SFV - Ok
- Discharge


- HOPE - Section A - Patient middle initial, Patient name suffix (check if optionnal or not)
- The patient can either have medicaid, medicare or both
- Prefered language: add a selection option
- Facility National Provider Identifier (NPI) and Facility CMS Certification Number (CCN) should be selected
- Patient zip code should be workflow controlled
- Section J: 500 error while clicking on Yes
- Give a clear message to users when they don't have the permissions to complete a SFV
- Give the possibility to review the SFV and put it in the calendar
- Review Payer / Coverage
- Complete Admission modal in the HOPE admission should be centered
- Move the Hope in the patient subview below "Care Team & Assignments"
- Move CTI (Certify Terminal Illness) and Face 2 Face in the patient subview (can be modified only by the doctor/MD and viewed by the other)
- Fix the patient subview changing
- In the ENcounters / visits view, the button should say "New encounter"
- In the encounters, show the error next to the fields
- In the encounters,, there should be a button to take the user to the care plan (view care plan & create new care plan buttons)
- Hide the section 5 in the encounter (VISIT LOGISTICS)
- Show alerts to the users
- Add a calendar so that the nurse can see all the encouters, HUV1, HOPE, CTI, F2F, MSW visits,...
So when there is something regarding a patient, everybody can see it
- Add the patient address from the referral inbox
- The signature of the CTI, add a window of 3 days for the doctor to sign it
- When signing the Election Statement, auto complete the current user's name in the signer name field
- When a F2F or CTI is needed is due (7 days before, 3 days before and 1 day after the due day), the system should alert the responsible party (doctor, nurse and administrator)
- In the patient views Demographics & Identifiers & Addresses, improve the UI/UX
- SHow the Coverage / Payers from the HOPE assessment or in the beggining they give it to use in the referral box, it needs to auto complete
- Review the care plan view
- In the care plan, show properly the error to the user
- Review and Fix the error when signing a care plan