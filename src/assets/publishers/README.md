# Publisher logos

These logos label the platforms in "Through your library" in the institution
dialog. They are bundled with the app because publishers block hotlinking, and so
the browser fetches nothing from a third party at runtime. A logo only identifies
the platform the library reaches; it does not imply an endorsement or a
relationship with PaperTok. Every platform in the Worker's `SERVICE_CATALOGUE`
needs one here; `publisherLogos.test.js` fails otherwise, and so does a file
without a row in one of the tables below.

## Public domain logos from Wikimedia Commons

Every file in this table is a public domain logo on Wikimedia Commons; the mark
belongs to its owner. The first twelve were retrieved 2026-10-13, the rest
2026-10-14. The files are unchanged except that `sciencedirect.svg`, `nature.svg`,
`tandf.svg`, `science.svg`, `iop.svg`, `acm.svg`, `ams.svg` and `karger.svg`
gained a `viewBox` taken from their own `width` and `height`, and that editor
metadata, `data-name` attributes and `<title>` elements were removed from
`jstor.svg`, `mitpress.svg`, `acm.svg`, `nejm.svg`, `spie.svg`, `ada.svg` and
`wolterskluwer.svg` (`nejm.svg` also lost an unused `<pattern>` of embedded bitmaps,
`ada.svg` a hidden group and an unused style rule, and `wolterskluwer.svg` gained a
`viewBox`).

| File | Commons title | Description page |
| --- | --- | --- |
| `acs.svg` | File:American Chemical Society logo 2026.svg | https://commons.wikimedia.org/wiki/File:American_Chemical_Society_logo_2026.svg |
| `ieee.svg` | File:IEEE logo.svg | https://commons.wikimedia.org/wiki/File:IEEE_logo.svg |
| `iop.svg` | File:Instituteofphysics.svg | https://commons.wikimedia.org/wiki/File:Instituteofphysics.svg |
| `nature.svg` | File:Nature Research logotype.svg | https://commons.wikimedia.org/wiki/File:Nature_Research_logotype.svg |
| `oup.svg` | File:OUP logo.svg | https://commons.wikimedia.org/wiki/File:OUP_logo.svg |
| `rsc.svg` | File:RSC-brand-guidelines-2019 tcm18-246471.svg | https://commons.wikimedia.org/wiki/File:RSC-brand-guidelines-2019_tcm18-246471.svg |
| `sage.svg` | File:SAGE Publishing logo 2023.svg | https://commons.wikimedia.org/wiki/File:SAGE_Publishing_logo_2023.svg |
| `science.svg` | File:Science AAAS logo.svg | https://commons.wikimedia.org/wiki/File:Science_AAAS_logo.svg |
| `sciencedirect.svg` | File:ScienceDirect logo 2020.svg | https://commons.wikimedia.org/wiki/File:ScienceDirect_logo_2020.svg |
| `springerlink.svg` | File:Springer Nature Logo.svg | https://commons.wikimedia.org/wiki/File:Springer_Nature_Logo.svg |
| `tandf.svg` | File:Taylor and Francis.svg | https://commons.wikimedia.org/wiki/File:Taylor_and_Francis.svg |
| `wiley.svg` | File:Wiley logo.svg | https://commons.wikimedia.org/wiki/File:Wiley_logo.svg |
| `acm.svg` | File:Association for Computing Machinery (ACM) logo.svg | https://commons.wikimedia.org/wiki/File:Association_for_Computing_Machinery_(ACM)_logo.svg |
| `ams.svg` | File:American Mathematical Society logo.svg | https://commons.wikimedia.org/wiki/File:American_Mathematical_Society_logo.svg |
| `asce.svg` | File:ASCE logo.svg | https://commons.wikimedia.org/wiki/File:ASCE_logo.svg |
| `brill.svg` | File:Logo of De Gruyter Brill.svg | https://commons.wikimedia.org/wiki/File:Logo_of_De_Gruyter_Brill.svg |
| `degruyter.svg` | File:Logo of De Gruyter Brill.svg | https://commons.wikimedia.org/wiki/File:Logo_of_De_Gruyter_Brill.svg |
| `jstor.svg` | File:JSTOR wordmark.svg | https://commons.wikimedia.org/wiki/File:JSTOR_wordmark.svg |
| `karger.svg` | File:Logo Karger.svg | https://commons.wikimedia.org/wiki/File:Logo_Karger.svg |
| `mitpress.svg` | File:MIT Press logo (black).svg | https://commons.wikimedia.org/wiki/File:MIT_Press_logo_(black).svg |
| `nejm.svg` | File:The New England Journal of Medicine logo.svg | https://commons.wikimedia.org/wiki/File:The_New_England_Journal_of_Medicine_logo.svg |
| `spie.svg` | File:SPIE DL Logo.svg | https://commons.wikimedia.org/wiki/File:SPIE_DL_Logo.svg |
| `ada.svg` | File:American Diabetes Association logo sans slogan.svg | https://commons.wikimedia.org/wiki/File:American_Diabetes_Association_logo_sans_slogan.svg |
| `wolterskluwer.svg` | File:Wolters Kluwer Logo.svg | https://commons.wikimedia.org/wiki/File:Wolters_Kluwer_Logo.svg |

## Logos from the publishers' own sites

Commons has no public domain vector of these marks (checked 2026-10-13 and
2026-10-14), so these files come from each publisher's website. They are not
public domain. As with the rest, they only identify the platform the library
reaches, and the mark and its artwork belong to the publisher. Retrieved
2026-10-14. Where a site only had a white logo for a dark header, its white fills
were set to `#1d1d1b` for the light plate. XML prologs, DOCTYPEs and comments were removed from every file.

| File | Source | Changes |
| --- | --- | --- |
| `aacr.svg` | https://aacr.silverchair-cdn.com/data/SiteBuilderAssetsOriginals/Live/images/umbrella/umbrella-logo.svg | None |
| `acp.svg` | https://www.acpjournals.org/specs/products/acp/releasedAssets/images/acp-logo-b2352777bcde7cbeac8f5fc91a37811e.svg | `viewBox="0 0 361 42"` added |
| `aea.svg` | https://www.aeaweb.org/assets/afc4f66/images/logo.svg | None |
| `aha.svg` | https://www.ahajournals.org/pb-assets/images/logo-publisher-white-1696767979407.svg | White recoloured |
| `aip.svg` | https://publishing.aip.org/wp-content/themes/bedstone/images/AIPP-Master-Logo-white-01.svg | White recoloured; `data-name` removed |
| `annualreviews.svg` | https://www.annualreviews.org/images/hybrid/ar-logo.svg | White recoloured; fixed `width` and `height` removed |
| `apa.svg` | The "APA PsycNet" wordmark inlined in the header of https://psycnet.apa.org | Angular `_ng*` and `data-name` attributes removed |
| `aps.svg` | https://journals.aps.org/images/aps-logo.svg | None |
| `asme.svg` | https://asmedc.silverchair-cdn.com/UI/app/svg/umbrella/logo.svg?versionId=5200 | None |
| `biologists.svg` | https://cob.silverchair-cdn.com/UI/app/svg/umbrella/logo.svg | White text recoloured; a comment removed |
| `cambridge.svg` | The "Cambridge Core" wordmark inlined in the header of https://www.cambridge.org/core | White recoloured; the page's `title` element and `role` and `style` attributes removed; `width` and `height` set to the `viewBox` |
| `chicago.svg` | https://press.uchicago.edu/.resources/ucp/img/logo.svg | `viewBox` added |
| `emerald.svg` | https://emer.silverchair-cdn.com/data/SiteBuilderAssetsOriginals/Live/Images/umbrella/umbrella-logo.svg | None |
| `jama.svg` | https://cdn.jamanetwork.com/UI/app/svg/journals/jamanetwork_brandingcolor.svg | XML prolog removed |
| `optica.svg` | The "OPTICA" wordmark inlined in the header of https://www.optica.org | `xmlns` added; `currentColor` set to `#000000` |
| `portland.svg` | https://port.silverchair-cdn.com/UI/app/svg/umbrella/logo-alternate.svg?versionId=8618 | None |
| `siam.svg` | https://www.siam.org/assets/images/accents/siam-logo.svg | Unused `class` attributes removed |
| `thieme.svg` | The header logo in https://www.thieme.com's script bundle (`assets/index.44a686bb7a8b5c2db873.js`) | The `<svg>` rebuilt from the bundle's eight path definitions; title dropped |
| `aap.svg` | https://aap2.silverchair-cdn.com/data/SiteBuilderAssetsOriginals/Live/images/umbrella/logo-aap_publications.svg | None |
| `asco.svg` | https://ascopubs.org/pb-assets/images/global/header/logo-white-1679404672980.svg | White recoloured |
| `brepols.svg` | https://www.brepolsonline.net/images/hybrid/logo/logo.svg | Illustrator `<metadata>` and `i:` elements, `id` and comment removed |
| `canscipub.svg` | https://cdnsciencepub.com/pb-assets/images/Logos/logo-1576779632563.svg | `viewBox` added; white wordmark recoloured |
| `dukeupress.svg` | https://dup.silverchair-cdn.com/data/SiteBuilderAssets/Live/Images/umbrella/dup-umbrella-logo-2084074164.svg | `id`, `xml:space`, `enable-background` and comment removed |
| `guilford.svg` | https://guilfordjournals.com/releasedAssets/images/desktop-header-logo-7083b1210891d927f769e0c78f470bdc.svg | None |
| `liverpoolup.svg` | https://www.liverpooluniversitypress.co.uk/pb-assets/images/Logos/header-logo-big-1674071309953.svg | None |
| `rsna.svg` | https://pubs.rsna.org/pb-assets/images/logos/default-header-logo-1739265343810.svg | Comment removed |
| `ucpress.svg` | https://ucp.silverchair-cdn.com/data/SiteBuilderAssetsOriginals/Live/Images/umbrella/umbrella-logo.svg | `id` and comment removed; `viewBox` tightened to the artwork (`34 34 364 76`) |

## Bitmap logos from the publishers' own sites

No vector version of these marks was found (checked 2026-10-14): the sites serve
PNG only, or an SVG that only wraps a bitmap. These are the publishers' own PNG
files, at least twice the plate's size, under the same terms as the table above.
Retrieved 2026-10-14; some through a Wayback Machine copy of the page when the
live site refused automated requests. Trimming removed empty margins only, down
to 4 px. `lyell.svg` is the one vector file of this batch.

| File | Source | Changes |
| --- | --- | --- |
| `aaa.png` | https://aaa.silverchair-cdn.com/data/SiteBuilderAssetsOriginals/Live/images/umbrella/AAA-logo.png?versionId=602 | Trimmed |
| `aiaa.png` | https://arc.aiaa.org/pb-assets/images/logo-header-2025-1750791241387.png (page via https://web.archive.org/web/20261003065627/https://arc.aiaa.org/) | None |
| `ametsoc.png` | https://journals.ametsoc.org/fileasset/AMS-Logo-Lockup-Journals-01.png | Trimmed |
| `aom.png` | https://www.aom.org/wp-content/uploads/2025/07/logo-1.png | Trimmed |
| `bmj.png` | https://journals.bmj.com/wp-content/uploads/2024/11/BMJ-Journals-Retina-Sized.png | None |
| `euclid.png` | https://projecteuclid.org/images/Project%20Euclid%20Images/Header_ProjectEuclid_Logo.png (via https://web.archive.org/web/20261013004531/https://projecteuclid.org/) | None |
| `informs.png` | https://pubsonline.informs.org/pb-assets/ux3/PubsOnLine_Horizontal_Logo-1562072942217.png (via https://web.archive.org/web/20261006084127/https://pubsonline.informs.org/) | None |
| `lyell.svg` | https://www.lyellcollection.org/specs/products/themes/photo/releasedAssets/images/logo-3e00aa2c1cc9e4d7030adf4184375f83.svg | None |
| `muse.png` | https://muse.jhu.edu/images/muselogo_dark.png | None |
| `physiology.png` | https://journals.physiology.org/pb-assets/images/Logo-footer-1557515659140.png (via Wayback snapshot 20261011212731) | Trimmed |
| `royalsociety.png` | https://trs.silverchair-cdn.com/data/SiteBuilderAssetsOriginals/Live/images/umbrella/TRS-logo-256x256-1.png (via https://web.archive.org/web/20260930144320/https://royalsocietypublishing.org/) | None |
| `worldscientific.png` | https://www.worldscientific.com/pb-assets/releasedAssets/images/WSPC-LOGO-250-1541381839657.png | Trimmed |
| `edinburghup.png` | https://edinburghuniversitypress.com/media/logo/stores/1/edinburgh-university-press-logo.png (page via https://web.archive.org/web/20261012055710/https://edinburghuniversitypress.com/) | Trimmed |
| `microbiologysociety.png` | https://www.microbiologyresearch.org/images/hybrid/logo/MBS_logo_full_size_desktop_hi-res.png | Trimmed |
| `msp.png` | https://msp.org/msp_org/static/img/msp-logo.png | 4 px margin added |


## News and business publications

Retrieved 2026-10-19. These identify the publication; its library route may be
an aggregator rather than the publisher website. ICO files retain the original
publisher favicon; PNG files and the Financial Times SVG are unchanged.

| File | Source |
| --- | --- |
| `economist.ico` | https://www.economist.com/favicon.ico |
| `financialtimes.svg` | [Wikimedia Commons, public-domain text logo](https://commons.wikimedia.org/wiki/File:Financial_Times_corporate_logo_(alternative).svg) |
| `wsj.ico` | https://www.wsj.com/favicon.ico |
| `nytimes.ico` | https://www.nytimes.com/favicon.ico |
| `newyorker.ico` | https://www.newyorker.com/verso/static/thenewyorker-us/assets/favicon.ico |
| `guardian.png` | https://assets.guim.co.uk/static/frontend/icons/homescreen/apple-touch-icon-120.png |
| `hbr.png` | https://hbr.org/resources/images/apple-touch-icon.png |
| `businessweek.ico` | https://www.bloomberg.com/favicon.ico |
